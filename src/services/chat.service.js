import { randomUUID } from "node:crypto";
import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { MemoryJobModel } from "../models/memory-job.model.js";
import { requireOwnedRelationship } from "./relationship.service.js";
import { allocateMessageSequence } from "./sequence.service.js";
import { assembleContext } from "./context.service.js";
import { attachCompanionPhoto, extractPhotoIntent } from "./companion-photo.service.js";
import { attachCompanionVoice, extractVoiceIntent } from "./companion-voice.service.js";
import { resolveCompanionMedia } from "./companion-media.service.js";
import { intentsFromToolCalls, toolsForCompanionTurn } from "./companion-tools.js";
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

/**
 * Transcribes a voice note and maps every failure mode to an HttpError the
 * client can show, instead of a generic 500.
 */
export async function transcribeVoiceNote({mediaProvider, media, mediaKey, signal}) {
    let transcript;
    try {
        transcript = await mediaProvider.transcribe({...media, signal});
    } catch (error) {
        if (signal?.aborted) throw error;
        console.error("[chat] voice note transcription failed", {
            mediaKey, mimeType: media.mimeType, bytes: media.buffer?.length,
            error: error.message, attempts: error.attempts,
        });
        throw new HttpError(502, "Lofn couldn't process that voice note right now. Please try sending it again.", "TRANSCRIPTION_FAILED");
    }
    const text = String(transcript?.text || "").trim();
    if (!text) {
        console.warn("[chat] voice note contained no speech", {
            mediaKey, mimeType: media.mimeType, bytes: media.buffer?.length, attempts: transcript?.attempts,
        });
        throw new HttpError(422, "We couldn't hear anything in that voice note. Try recording again, a little closer to the mic.", "EMPTY_VOICE_NOTE");
    }
    return {...transcript, text};
}

export async function generateReply({relationshipId, userId, body, env, llm, visionLlm, mediaProvider, storage, embeddingProvider, signal, emit}) {
    if (!llm) throw new HttpError(503, "The LLM provider is not configured", "LLM_NOT_CONFIGURED");
    return withChatLease(relationshipId, userId, async timeout => {
        const generationSignal = AbortSignal.any([timeout, signal]);
        let user = await MessageModel.findOne({relationshipId, clientMessageId: body.clientMessageId});
        const mediaKeyMismatch = (user?.mediaKey || "") !== (body.mediaKey || "");
        const contentMismatch = body.mediaType === "audio"
            ? Boolean(body.content && user?.content !== body.content && !user?.content?.startsWith(body.content))
            : user?.content !== body.content;
        if (user && (user.role !== "user" || mediaKeyMismatch || contentMismatch)) {
            throw new HttpError(409, "Retry content must match the original message", "MESSAGE_CONFLICT");
        }
        let selectedLlm = llm;
        let currentMessage = body.content;
        let currentMedia;
        let mediaMeta = body.mediaMeta || {};
        if (body.mediaKey) {
            const expectedPrefix = `messages/${relationshipId}/`;
            if (!body.mediaKey.startsWith(expectedPrefix)) {
                throw new HttpError(400, "Invalid message media", "INVALID_MEDIA_KEY");
            }
            if (!storage) throw new HttpError(503, "Media storage is unavailable", "STORAGE_UNAVAILABLE");
            const media = await storage.readBuffer(body.mediaKey);
            if (body.mediaType === "audio") {
                if (!media.mimeType?.startsWith("audio/")) throw new HttpError(400, "Choose an audio file", "INVALID_FILE_TYPE");
                if (!user) {
                    if (!mediaProvider) throw new HttpError(503, "Audio transcription is not configured", "MEDIA_MODEL_NOT_CONFIGURED");
                    const transcript = await transcribeVoiceNote({mediaProvider, media, mediaKey: body.mediaKey, signal: generationSignal});
                    mediaMeta = {...mediaMeta, mimeType: media.mimeType, transcript: transcript.text, transcriptModel: transcript.model};
                    currentMessage = body.content
                        ? `${body.content}\n\n[Voice message transcript: ${transcript.text}]`
                        : transcript.text;
                } else {
                    const transcript = user.mediaMeta?.transcript || user.content;
                    currentMessage = body.content
                        ? `${body.content}\n\n[Voice message transcript: ${transcript}]`
                        : transcript;
                }
            } else if (body.mediaType === "image") {
                if (!media.mimeType?.startsWith("image/")) throw new HttpError(400, "Choose an image file", "INVALID_FILE_TYPE");
                if (!visionLlm) throw new HttpError(503, "Image understanding is not configured", "MEDIA_MODEL_NOT_CONFIGURED");
                selectedLlm = visionLlm;
                currentMessage = body.content || "[The user sent an image. React naturally to what you can see.]";
                currentMedia = {mimeType: media.mimeType, data: media.buffer.toString("base64")};
                mediaMeta = {...mediaMeta, mimeType: media.mimeType};
            }
        }
        if (!user) user = await MessageModel.create({
            relationshipId, sequenceNumber: await allocateMessageSequence(relationshipId, userId),
            role: "user", content: body.mediaType === "audio" ? (body.content || mediaMeta.transcript) : body.content,
            status: "completed", clientMessageId: body.clientMessageId, completedAt: new Date(),
            mediaUrl: body.mediaUrl, mediaKey: body.mediaKey, mediaType: body.mediaType, mediaMeta,
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
            generation: {provider: selectedLlm.name, model: selectedLlm.model},
        });
        let content = "";
        const startedAt = Date.now();
        let lastPersisted = startedAt;
        try {
            generationSignal.throwIfAborted();
            const context = await assembleContext({relationshipId, userId,
                currentSequence: user.sequenceNumber, currentMessage, currentMedia,
                embeddingProvider, vectorEnabled: env.MEMORY_VECTOR_SEARCH_ENABLED,
                vectorIndexName: env.MEMORY_VECTOR_INDEX, userTimezone: body.timezone, signal: generationSignal,
            });
            generationSignal.throwIfAborted();
            emit("seen", { userMessageId: user._id, userSequence: user.sequenceNumber, seenAt: seenAt.toISOString() });
            emit("message", {id: assistant._id, userId: user._id, userSequence: user.sequenceNumber, sequenceNumber: assistant.sequenceNumber});
            let toolCalls = [];
            const mediaTurn = toolsForCompanionTurn(currentMessage);
            for await (const chunk of selectedLlm.streamChat({
                messages: context.messages,
                tools: mediaTurn.tools,
                toolChoice: mediaTurn.toolChoice,
                signal: generationSignal,
            })) {
                generationSignal.throwIfAborted();
                if (chunk && typeof chunk === "object" && Array.isArray(chunk.toolCalls)) {
                    toolCalls = chunk.toolCalls;
                    continue;
                }
                const text = typeof chunk === "string" ? chunk : "";
                if (!text) continue;
                content += text;
                if (content.length > 100_000) throw new Error("Reply is too long");
                emit("delta", {content: text});
                if (Date.now() - lastPersisted > 1000) {
                    await MessageModel.updateOne({_id: assistant._id, status: "streaming"}, {$set: {content}});
                    lastPersisted = Date.now();
                }
            }
            generationSignal.throwIfAborted();
            const fromTools = intentsFromToolCalls(toolCalls);
            const taggedPhoto = extractPhotoIntent(content);
            content = extractVoiceIntent(taggedPhoto.content).content;
            const resolved = resolveCompanionMedia({
                toolPhoto: fromTools.photo || taggedPhoto.intent,
                toolVoice: fromTools.voice,
                userText: currentMessage,
                replyText: content,
                photoNeeded: mediaTurn.photoNeeded,
                voiceNeeded: mediaTurn.voiceNeeded,
            });
            const photoIntent = resolved.photo;
            const voiceIntent = resolved.voice;
            if (!content.trim() && fromTools.photo?.action === "refuse") {
                content = fromTools.photo.reason || "not sending one.";
            } else if (!content.trim() && fromTools.voice?.action === "refuse") {
                content = fromTools.voice.reason || "not sending a voice note.";
            }
            if (!content.trim() && !voiceIntent && !photoIntent) {
                throw new Error("The model returned an empty response");
            }
            const saved = await MessageModel.updateOne({_id: assistant._id, status: "streaming"}, {$set: {
                content, status: "completed", completedAt: new Date(), memoryPending: true,
                "generation.latencyMs": Date.now() - startedAt, "generation.retrievedMemoryIds": context.retrievedMemoryIds,
                "generation.mediaDecision": resolved.decision,
            }});
            if (!saved.modifiedCount) throw new Error("Reply lease expired");
            if (voiceIntent && !photoIntent) {
                await attachCompanionVoice({
                    relationshipId, assistantMessage: assistant,
                    replyText: content, intent: voiceIntent, mediaProvider, storage,
                });
            } else if (photoIntent) {
                await attachCompanionPhoto({
                    relationshipId, assistantMessage: assistant, intent: photoIntent, mediaProvider, storage,
                });
            }
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
