import { MessageModel } from "../models/message.model.js";
import { HttpError } from "../utils/http-error.js";
import { allocateMessageSequence } from "./sequence.service.js";
import { isStyleFeedback } from "./conversation-repair.service.js";
import { assembleContext } from "./context.service.js";
export async function initiateScenario({relationshipId, userId, llm, userTimezone, signal, triggerType = "check_in"}) {
    if (!llm) throw new HttpError(503, "The LLM provider is not configured", "LLM_NOT_CONFIGURED");
    // Older clients may still request timed bubbles. Never double-text a tone repair.
    if (["follow_up", "idle_nudge"].includes(triggerType)) {
        const latestUser = await MessageModel.findOne({relationshipId, role: "user", status: "completed"})
            .sort({sequenceNumber: -1}).select("content").lean();
        if (latestUser && isStyleFeedback(latestUser.content)) return null;
    }
    const context = await assembleContext({relationshipId, userId, userTimezone, signal, initiating: true, triggerType});
    const content = await llm.generateText({messages: context.messages, signal});
    signal?.throwIfAborted();
    if (!content.trim()) throw new Error("Empty initiation reply");
    return MessageModel.create({relationshipId,
        sequenceNumber: await allocateMessageSequence(relationshipId, userId),
        role: "assistant", origin: "initiated", content, status: "completed", completedAt: new Date(),
        generation: {provider: llm.name, model: llm.model},
    });
}
