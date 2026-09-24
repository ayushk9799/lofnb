import { z } from "zod";

export const conversationUpdateSchema = z.object({
    activeThread: z.string().trim().max(600).optional(),
    pendingQuestion: z.string().trim().max(400).optional(),
    sharedContext: z.string().trim().max(1000).optional(),
    familiarity: z.enum(["unfamiliar", "getting_familiar", "familiar"]).optional(),
    trust: z.enum(["unknown", "developing", "established"]).optional(),
    romanticComfort: z.enum(["unknown", "welcome", "declined"]).optional(),
    commitment: z.enum(["unspecified", "friends", "partners"]).optional(),
    mutualAgreement: z.boolean().optional(),
    userEvidence: z.string().trim().max(800).default(""),
    assistantEvidence: z.string().trim().max(800).default(""),
    scene: z.object({
        description: z.string().trim().min(1).max(800),
        status: z.enum(["active", "resolved"]),
        evidence: z.string().trim().min(1).max(800),
    }).optional(),
});

const supports = (text, quote) => Boolean(quote?.trim() && String(text || "").includes(quote));
function gradual(previous, next, levels) {
    if (!next) return previous;
    const before = Math.max(0, levels.indexOf(previous));
    const after = levels.indexOf(next);
    return levels[Math.min(after, before + 1)];
}

// The extractor proposes meaning; the reducer enforces provenance, incremental
// progression, ordering, and bilateral evidence for commitment.
export function reduceConversationState(previous = {}, update, { user, assistant, now = new Date() }) {
    if (!update || assistant.sequenceNumber <= (previous.sequence || 0)) return previous;
    const userSupported = supports(user?.content, update.userEvidence);
    const assistantSupported = supports(assistant.content, update.assistantEvidence);
    if (!userSupported && !assistantSupported) return previous;
    const next = { ...previous, version: 1, sequence: assistant.sequenceNumber };
    for (const key of ["activeThread", "pendingQuestion", "sharedContext"]) {
        if (update[key] !== undefined) next[key] = update[key];
    }
    if (userSupported) {
        next.familiarity = gradual(previous.familiarity || "unfamiliar", update.familiarity, ["unfamiliar", "getting_familiar", "familiar"]);
        next.trust = gradual(previous.trust || "unknown", update.trust, ["unknown", "developing", "established"]);
        if (update.romanticComfort) next.romanticComfort = update.romanticComfort;
        if (update.commitment === "friends" || update.commitment === "unspecified") next.commitment = update.commitment;
        if (update.commitment === "partners" && update.mutualAgreement === true && assistantSupported) next.commitment = "partners";
    }
    if (update.scene && supports(assistant.content, update.scene.evidence)) {
        const same = previous.scene?.description === update.scene.description;
        next.scene = {
            description: update.scene.description,
            status: update.scene.status,
            establishedAt: same ? previous.scene.establishedAt : now,
            // Repeating an event does not extend its present-tense lifetime.
            expiresAt: same ? previous.scene.expiresAt : new Date(new Date(now).getTime() + 24 * 60 * 60 * 1000),
            sourceMessageId: assistant._id,
        };
    }
    next.evidence = [userSupported && update.userEvidence, assistantSupported && update.assistantEvidence].filter(Boolean).join("\n");
    next.sourceMessageIds = [userSupported && user?._id, assistantSupported && assistant._id].filter(Boolean);
    return next;
}

export function conversationContext(state = {}, now = new Date()) {
    const scene = state.scene?.description ? {
        ...state.scene,
        status: state.scene.status === "active" && new Date(state.scene.expiresAt).getTime() <= new Date(now).getTime() ? "past; outcome unknown" : state.scene.status,
    } : undefined;
    return {
        familiarity: state.familiarity || "unfamiliar",
        trust: state.trust || "unknown",
        romanticComfort: state.romanticComfort || "unknown",
        commitment: state.commitment || "unspecified",
        activeThread: state.activeThread || "",
        pendingQuestion: state.pendingQuestion || "",
        sharedContext: state.sharedContext || "",
        scene,
    };
}

export const CONVERSATION_EXTRACTION_INSTRUCTIONS = [
    "Also return optional conversationUpdate: {activeThread?, pendingQuestion?, sharedContext?, familiarity?:unfamiliar|getting_familiar|familiar, trust?:unknown|developing|established, romanticComfort?:unknown|welcome|declined, commitment?:unspecified|friends|partners, mutualAgreement?:boolean, userEvidence, assistantEvidence, scene?:{description,status:active|resolved,evidence}}.",
    "Evidence fields are exact quotes from the current message of that speaker, never from previous context. Omit unsupported updates. Initiated turns have no user evidence and cannot increase familiarity, trust or commitment.",
    "Track the active topic, any unanswered question (clear it with an empty string when answered/declined), and a compact shared reference needed for callbacks. Follow topic changes. Preserve established facts, but clear stale assumptions after corrections.",
    "Familiarity can grow from reciprocal stories, welcomed callbacks, and conversational ease without anyone declaring friendship. Trust needs user evidence of comfort or openness, not just greetings, message count, purchases, flirting, or time elapsed. Do not lower trust because the user is away or declines a topic.",
    "Romantic comfort records whether flirting is welcome; it does not imply commitment. Only propose partners and mutualAgreement=true when BOTH current messages explicitly agree to being partners. A unilateral request, joke, hypothetical, refusal, or sexual conversation is not mutual agreement. Explicit user requests to stop flirting or return to friendship apply immediately.",
    "Scene is an ordinary fictional character event actually stated in the current assistant message, never a candidate idea, hypothetical, major invented biography, or an event attributed to the user. Preserve its established details while active; resolve only when the assistant reports an outcome. Do not turn tomorrow's plan into something happening now; include timing in description.",
    "Remember explicit interaction preferences (e.g. fewer questions, no teasing) as user_boundary_<topic> memories, grounded only in the user message.",
].join("\n");
