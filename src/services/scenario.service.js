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
import { attachCompanionPhoto, extractPhotoIntent, replyClaimsPhoto } from "./companion-photo.service.js";
import { attachCompanionVoice, extractVoiceIntent } from "./companion-voice.service.js";

export async function initiateScenario({
    relationshipId,
    userId,
    llm,
    userTimezone,
    signal,
    triggerType = "check_in",
    expectedSequence,
    mediaProvider,
    storage,
    env,
    presence = {},
}) {
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
    if (triggerType !== "opener" && (!latest || (latest.origin === "initiated" && !["callback", "return_to_chat"].includes(triggerType)))) return null;
    if (triggerType === "check_in" && (latest.role !== "user" || await MessageModel.exists({relationshipId, replyToMessageId: latest._id}))) return null;
    if (triggerType === "idle_nudge") {
        if (latest.role !== "assistant") return null;
        const lastUserMsg = await MessageModel.findOne({ relationshipId, role: "user" }).sort({ sequenceNumber: -1 }).lean();
        if (lastUserMsg && isStyleFeedback(lastUserMsg.content)) return null;
    }
    await ensureProfileMemory({ relationshipId, userId, llm, signal });
    const context = await assembleContext({relationshipId, userId, userTimezone, signal, initiating: true, triggerType, llm, presence,
        ...(triggerType === "check_in" ? { currentSequence: latest.sequenceNumber, currentMessage: latest.content } : {}),
        mediaCapabilities: {
            image: Boolean(storage && (mediaProvider?.generateImage || env?.NODE_ENV === "development")),
            audio: Boolean(mediaProvider?.synthesize && storage?.upload),
        },
    });
    if (context.turnPlan?.move === "wait") return null;
    const rawContent = await llm.generateText({messages: context.messages, signal});
    signal?.throwIfAborted();
    if (!rawContent.trim()) throw new Error("Empty initiation reply");
    if (rawContent.trim() === "[NO_MESSAGE]") return null;

    const taggedPhoto = extractPhotoIntent(rawContent);
    const taggedVoice = extractVoiceIntent(taggedPhoto.content);
    let content = taggedVoice.content
        .replace(/\s*\[(?:sent|refused) a (?:photo|picture|voice note)\]/gi, "")
        .trim();
    if (!content && !taggedPhoto.intent && !taggedVoice.intent) content = rawContent.trim();

    let photoIntent = taggedPhoto.intent;
    let voiceIntent = taggedVoice.intent;
    if (!photoIntent && !voiceIntent && replyClaimsPhoto(content)) {
        photoIntent = { query: content.slice(0, 120) };
    }

    if (!context.availableMedia.image) photoIntent = null;
    if (!context.availableMedia.audio) voiceIntent = null;
    if ((taggedPhoto.intent && !photoIntent) || (taggedVoice.intent && !voiceIntent)) return null;

    const messageId = new Types.ObjectId();
    const saved = await MessageModel.create({
        _id: messageId,
        relationshipId,
        sequenceNumber: await allocateMessageSequence(relationshipId, userId),
        role: "assistant",
        origin: "initiated",
        content,
        status: "streaming",
        bubbles: createReplyBubbles(content, messageId),
        memoryPending: false,
        ...(triggerType === "check_in" ? {replyToMessageId: latest._id} : {}),
        generation: {
            provider: llm.name,
            model: llm.model,
            mediaDecision: voiceIntent ? "audio_sent" : (photoIntent ? "image_sent" : undefined),
        },
    });


    if (voiceIntent && !photoIntent && mediaProvider && storage) {
        const voiceResult = await attachCompanionVoice({
            relationshipId,
            assistantMessage: saved,
            replyText: content,
            intent: voiceIntent,
            mediaProvider,
            storage,
        });
        if (voiceResult?.url) {
            saved.mediaUrl = voiceResult.url;
            saved.mediaType = "audio";
            saved.mediaMeta = voiceResult.mediaMeta;
            if (voiceResult.key) saved.mediaKey = voiceResult.key;
        }
    } else if (photoIntent && (storage || mediaProvider)) {
        const photoResult = await attachCompanionPhoto({
            relationshipId,
            assistantMessage: saved,
            intent: photoIntent,
            mediaProvider,
            storage,
            skipImageGeneration: env?.ENABLE_IMAGE_GENERATION !== undefined
                ? !env.ENABLE_IMAGE_GENERATION
                : env?.NODE_ENV === "development",
        });
        if (photoResult?.url || photoResult?.mediaUrl) {
            saved.mediaUrl = photoResult.url || photoResult.mediaUrl;
            saved.mediaType = photoResult.mediaType || "image";
            saved.mediaMeta = photoResult.mediaMeta;
            if (photoResult.key || photoResult.mediaKey) {
                saved.mediaKey = photoResult.key || photoResult.mediaKey;
            }
        }
    }

    if ((photoIntent || voiceIntent) && !saved.mediaUrl) {
        saved.content = photoIntent ? "couldn't get that photo through just now." : "couldn't get that voice note through just now.";
        saved.bubbles = createReplyBubbles(saved.content, saved._id);
    }
    content = saved.content;
    saved.generation.mediaDecision = saved.mediaType === "image" ? "image_sent" : saved.mediaType === "audio" ? "audio_sent" : "text";
    saved.status = "completed";
    saved.completedAt = new Date();
    saved.memoryPending = true;
    await saved.save();
    await enqueueMemory(saved).catch(() => console.warn("Initiated memory scheduling deferred to recovery"));
    await RelationshipModel.updateOne({_id: relationshipId}, {$set: {lastInitiatedAt: new Date()}});
    if (triggerType === "opener") {
        await RelationshipModel.updateOne({_id: relationshipId}, {$set: {openerSentAt: new Date(), lastInitiatedAt: new Date()}});
    }

    try {
        const rel = await RelationshipModel.findById(relationshipId).populate("characterId").lean();
        const charName = rel?.characterId?.name || "Companion";
        const charAvatar = rel?.characterId?.avatarUrl || "";
        const pushContent = saved.mediaType === "image"
            ? (content ? `📷 Photo: ${content}` : "📷 Sent a photo")
            : (saved.mediaType === "audio"
                ? (content ? `🎙️ Voice Note: ${content}` : "🎙️ Sent a voice note")
                : content);
        sendChatPushNotification({
            userId,
            characterName: charName,
            content: pushContent,
            relationshipId,
            avatarUrl: charAvatar,
            extraData: { triggerType, sequenceNumber: saved.sequenceNumber, mediaType: saved.mediaType },
        }).catch(err => console.warn("[Push] Error dispatching scenario push:", err.message));
    } catch (err) {
        console.warn("[Push] Error checking relationship for scenario push:", err.message);
    }

    return saved;
}
