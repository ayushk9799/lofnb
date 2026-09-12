import { randomUUID } from "node:crypto";
import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { MemoryJobModel } from "../models/memory-job.model.js";
import { requireOwnedRelationship } from "./relationship.service.js";
import { allocateMessageSequence } from "./sequence.service.js";
import { assembleContext } from "./context.service.js";
import { HttpError } from "../utils/http-error.js";
import { sendChatPushNotification } from "./push-notification.service.js";

export async function withChatLease(relationshipId, userId, work) {
    await requireOwnedRelationship(relationshipId, userId);
    const token = randomUUID();
    const relationship = await RelationshipModel.findOneAndUpdate({
        _id: relationshipId, userId,
        $or: [{"chatLease.expiresAt": {$lte: new Date()}}, {"chatLease.expiresAt": {$exists: false}}],
    }, {$set: {chatLease: {token, expiresAt: new Date(Date.now() + 120_000)}}});
    if (!relationship) throw new HttpError(409, "A reply is already in progress. Please retry shortly.", "CHAT_BUSY");
    try {
        // An expired lease means the prior process could not finish this turn.
        await MessageModel.updateMany({relationshipId, status: "streaming"}, [{$set: {
            status: {$cond: [{$ne: ["$content", ""]}, "partial", "failed"]}, completedAt: new Date(),
        }}]);
        return await work(AbortSignal.timeout(90_000));
    } finally {
        await RelationshipModel.updateOne({_id: relationshipId, "chatLease.token": token}, {$unset: {chatLease: 1}})
            .catch(() => console.warn("Chat lease will expire automatically"));
    }
}

export async function enqueueMemory(message) {
    await MemoryJobModel.updateOne({assistantMessageId: message._id}, {$setOnInsert: {
        relationshipId: message.relationshipId, userMessageId: message.replyToMessageId,
        assistantMessageId: message._id, status: "pending", availableAt: new Date(),
    }}, {upsert: true});
    await MessageModel.updateOne({_id: message._id}, {$set: {memoryPending: false}});
}

export async function generateReply({relationshipId, userId, body, env, llm, embeddingProvider, signal, emit}) {
    if (!llm) throw new HttpError(503, "The LLM provider is not configured", "LLM_NOT_CONFIGURED");
    return withChatLease(relationshipId, userId, async timeout => {
        const generationSignal = AbortSignal.any([timeout, signal]);
        let user = await MessageModel.findOne({relationshipId, clientMessageId: body.clientMessageId});
        if (user && (user.content !== body.content || user.role !== "user")) {
            throw new HttpError(409, "Retry content must match the original message", "MESSAGE_CONFLICT");
        }
        if (!user) user = await MessageModel.create({
            relationshipId, sequenceNumber: await allocateMessageSequence(relationshipId, userId),
            role: "user", content: body.content, status: "completed", clientMessageId: body.clientMessageId, completedAt: new Date(),
            mediaUrl: body.mediaUrl, mediaKey: body.mediaKey, mediaType: body.mediaType,
        });
        const seenAt = new Date();
        if (!user.readAt) {
            user.readAt = seenAt;
            await MessageModel.updateOne({ _id: user._id }, { $set: { readAt: seenAt } });
        }
        await RelationshipModel.findByIdAndUpdate(relationshipId, {
            $max: { companionLastReadSequence: user.sequenceNumber },
            $set: { companionLastReadAt: seenAt },
        });

        let assistant = await MessageModel.findOne({relationshipId, replyToMessageId: user._id});
        if (assistant && ["completed", "partial"].includes(assistant.status)) {
            emit("seen", { userMessageId: user._id, userSequence: user.sequenceNumber, seenAt: seenAt.toISOString() });
            emit("message", {id: assistant._id, userId: user._id, userSequence: user.sequenceNumber, sequenceNumber: assistant.sequenceNumber});
            emit("delta", {content: assistant.content});
            emit("done", {cached: true, status: assistant.status});
            return;
        }
        // Failed empty replies can be regenerated with the same request ID, without a second user message.
        if (assistant) {
            assistant.status = "streaming";
            assistant.content = "";
            await assistant.save();
        } else assistant = await MessageModel.create({
            relationshipId, sequenceNumber: await allocateMessageSequence(relationshipId, userId),
            role: "assistant", status: "streaming", replyToMessageId: user._id,
            generation: {provider: llm.name, model: llm.model},
        });
        let content = "";
        const startedAt = Date.now();
        let lastPersisted = startedAt;
        try {
            generationSignal.throwIfAborted();
            const context = await assembleContext({relationshipId, userId,
                currentSequence: user.sequenceNumber, currentMessage: user.content,
                embeddingProvider, vectorEnabled: env.MEMORY_VECTOR_SEARCH_ENABLED,
                vectorIndexName: env.MEMORY_VECTOR_INDEX, userTimezone: body.timezone, signal: generationSignal,
            });
            generationSignal.throwIfAborted();
            emit("seen", { userMessageId: user._id, userSequence: user.sequenceNumber, seenAt: seenAt.toISOString() });
            emit("message", {id: assistant._id, userId: user._id, userSequence: user.sequenceNumber, sequenceNumber: assistant.sequenceNumber});
            for await (const chunk of llm.streamChat({messages: context.messages, signal: generationSignal})) {
                generationSignal.throwIfAborted();
                content += chunk;
                if (content.length > 100_000) throw new Error("Reply is too long");
                emit("delta", {content: chunk});
                if (Date.now() - lastPersisted > 1000) {
                    await MessageModel.updateOne({_id: assistant._id, status: "streaming"}, {$set: {content}});
                    lastPersisted = Date.now();
                }
            }
            generationSignal.throwIfAborted();
            if (!content.trim()) throw new Error("The model returned an empty response");
            const saved = await MessageModel.updateOne({_id: assistant._id, status: "streaming"}, {$set: {
                content, status: "completed", completedAt: new Date(), memoryPending: true,
                "generation.latencyMs": Date.now() - startedAt, "generation.retrievedMemoryIds": context.retrievedMemoryIds,
            }});
            if (!saved.modifiedCount) throw new Error("Reply lease expired");
            // The completed message is the durable outbox. A worker recovers a failed enqueue.
            await enqueueMemory(assistant).catch(() => console.warn("Memory scheduling deferred to recovery"));
            emit("done", {status: "completed"});

            // Dispatch push notification for completed reply
            try {
                const rel = await RelationshipModel.findById(relationshipId).populate("characterId").lean();
                const charName = rel?.characterId?.name || "Companion";
                sendChatPushNotification({
                    userId,
                    characterName: charName,
                    content,
                    relationshipId,
                }).catch(err => console.warn("[Push] Error dispatching push:", err.message));
            } catch (err) {
                console.warn("[Push] Error checking relationship for push:", err.message);
            }
        } catch (error) {
            await MessageModel.updateOne({_id: assistant._id, status: "streaming"}, {$set: {
                content: content.slice(0, 100_000), status: content ? "partial" : "failed", completedAt: new Date(),
            }}).catch(() => console.warn("Interrupted reply will be recovered after lease expiry"));
            throw error;
        }
    });
}
