import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { HttpError } from "../utils/http-error.js";
import { allocateMessageSequence } from "./sequence.service.js";
import { isStyleFeedback } from "./conversation-repair.service.js";
import { assembleContext } from "./context.service.js";
import { sendChatPushNotification } from "./push-notification.service.js";

export async function initiateScenario({relationshipId, userId, llm, userTimezone, signal, triggerType = "check_in"}) {
    if (!llm) throw new HttpError(503, "The LLM provider is not configured", "LLM_NOT_CONFIGURED");
    // Older clients may still request timed bubbles. Never double-text a tone repair.
    if (["follow_up", "idle_nudge", "left_on_read"].includes(triggerType)) {
        const latestUser = await MessageModel.findOne({relationshipId, role: "user", status: "completed"})
            .sort({sequenceNumber: -1}).select("content").lean();
        if (latestUser && isStyleFeedback(latestUser.content)) return null;
    }
    const context = await assembleContext({relationshipId, userId, userTimezone, signal, initiating: true, triggerType});
    const content = await llm.generateText({messages: context.messages, signal});
    signal?.throwIfAborted();
    if (!content.trim()) throw new Error("Empty initiation reply");
    const saved = await MessageModel.create({relationshipId,
        sequenceNumber: await allocateMessageSequence(relationshipId, userId),
        role: "assistant", origin: "initiated", content, status: "completed", completedAt: new Date(),
        generation: {provider: llm.name, model: llm.model},
    });

    try {
        const rel = await RelationshipModel.findById(relationshipId).populate("characterId").lean();
        const charName = rel?.characterId?.name || "Companion";
        sendChatPushNotification({
            userId,
            characterName: charName,
            content,
            relationshipId,
            extraData: { triggerType },
        }).catch(err => console.warn("[Push] Error dispatching scenario push:", err.message));
    } catch (err) {
        console.warn("[Push] Error checking relationship for scenario push:", err.message);
    }

    return saved;
}
