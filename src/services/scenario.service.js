import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { HttpError } from "../utils/http-error.js";
import { allocateMessageSequence } from "./sequence.service.js";
import { enqueueMemory } from "./chat.service.js";
import { createReplyBubbles } from "./reply-bubbles.service.js";
import { Types } from "mongoose";
import { assembleContext, ensureProfileMemory } from "./context.service.js";
import { sendChatPushNotification } from "./push-notification.service.js";
import { isStyleFeedback } from "./conversation-repair.service.js";

export async function initiateScenario({relationshipId, userId, llm, userTimezone, signal, triggerType = "check_in", expectedSequence}) {
    if (!llm) throw new HttpError(503, "The LLM provider is not configured", "LLM_NOT_CONFIGURED");
    // An opener is only ever the first message. If either side already spoke,
    // mark it done so the worker stops retrying and nothing is sent.
    if (triggerType === "opener") {
        const anyMessage = await MessageModel.exists({relationshipId, status: {$in: ["completed", "partial", "streaming"]}});
        if (anyMessage) {
            await RelationshipModel.updateOne({_id: relationshipId}, {$set: {openerSentAt: new Date()}});
            return null;
        }
    }
    // Old client timers cannot manufacture extra bubbles or guilt messages.
    if (["follow_up", "left_on_read"].includes(triggerType)) return null;
    const latest = await MessageModel.findOne({relationshipId}).sort({sequenceNumber: -1}).lean();
    if (expectedSequence !== undefined && latest?.sequenceNumber !== expectedSequence) return null;
    if (triggerType !== "opener" && (!latest || latest.origin === "initiated")) return null;
    if (triggerType === "check_in" && (latest.role !== "user" || await MessageModel.exists({relationshipId, replyToMessageId: latest._id}))) return null;
    if (triggerType === "idle_nudge") {
        if (latest.role !== "assistant") return null;
        const lastUserMsg = await MessageModel.findOne({ relationshipId, role: "user" }).sort({ sequenceNumber: -1 }).lean();
        if (lastUserMsg && isStyleFeedback(lastUserMsg.content)) return null;
    }
    await ensureProfileMemory({ relationshipId, userId, llm, signal });
    const context = await assembleContext({relationshipId, userId, userTimezone, signal, initiating: true, triggerType});
    const content = await llm.generateText({messages: context.messages, signal});
    signal?.throwIfAborted();
    if (!content.trim()) throw new Error("Empty initiation reply");
    if (content.trim() === "[NO_MESSAGE]") return null;
    const messageId = new Types.ObjectId();
    const saved = await MessageModel.create({_id: messageId, relationshipId,
        sequenceNumber: await allocateMessageSequence(relationshipId, userId),
        role: "assistant", origin: "initiated", content, status: "completed", completedAt: new Date(),
        bubbles: createReplyBubbles(content, messageId), memoryPending: true,
        ...(triggerType === "check_in" ? {replyToMessageId: latest._id} : {}),
        generation: {provider: llm.name, model: llm.model},
    });
    await enqueueMemory(saved).catch(() => console.warn("Initiated memory scheduling deferred to recovery"));
    await RelationshipModel.updateOne({_id: relationshipId}, {$set: {lastInitiatedAt: new Date()}});
    if (triggerType === "opener") {
        await RelationshipModel.updateOne({_id: relationshipId}, {$set: {openerSentAt: new Date(), lastInitiatedAt: new Date()}});
    }

    try {
        const rel = await RelationshipModel.findById(relationshipId).populate("characterId").lean();
        const charName = rel?.characterId?.name || "Companion";
        const charAvatar = rel?.characterId?.avatarUrl || "";
        sendChatPushNotification({
            userId,
            characterName: charName,
            content,
            relationshipId,
            avatarUrl: charAvatar,
            extraData: { triggerType, sequenceNumber: saved.sequenceNumber },
        }).catch(err => console.warn("[Push] Error dispatching scenario push:", err.message));
    } catch (err) {
        console.warn("[Push] Error checking relationship for scenario push:", err.message);
    }

    return saved;
}
