import { MessageModel } from "../models/message.model.js";

const VOICE_TAG = /%%VOICE(?:\s*\|\s*([^%\n]+))?(?:\s*%%)?/gi;
const VOICE_COOLDOWN_TURNS = 3;

export function extractVoiceIntent(text) {
    const raw = String(text || "");
    let spoken = null;
    const content = raw.replace(VOICE_TAG, (_all, script) => {
        spoken = String(script || "").trim();
        return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
    return {
        content,
        intent: spoken != null ? { kind: "voice", spoken } : null,
    };
}

export function userAskedForVoice(text) {
    const value = String(text || "");
    return (
        /\b(send|drop|share|leave|record)\b.{0,28}\b(voice( ?note)?|audio|voicenote)\b/i.test(value) ||
        /\b(voice( ?note)?|audio)\b.{0,20}\b(please|pls|of (it|that|this))\b/i.test(value) ||
        /\bcan (you|u) (send|drop|leave) (me )?(a )?(voice|audio|voicenote)\b/i.test(value) ||
        /\b(voice note|voicenote|send audio|send voice)\b/i.test(value)
    );
}

export function looksLikeVoiceRefusal(text) {
    return /\b(can'?t|cannot|unable|won'?t|don't|do not|not able)\b.{0,48}\b(voice|audio|record|voicenote)/i.test(
        String(text || ""),
    );
}

export function decideCompanionVoice({ intent, asked, rateLimited }) {
    if (rateLimited && !asked) return null;
    if (intent) return intent;
    if (asked) return { kind: "voice", spoken: "" };
    return null;
}

export function estimateSpeechDurationMs(text = "") {
    const words = String(text).trim().split(/\s+/).filter(Boolean).length;
    const seconds = Math.min(45, Math.max(1.2, words / 2.5));
    return Math.round(seconds * 1000);
}

export async function isVoiceRateLimited(relationshipId, currentSequence) {
    const last = await MessageModel.findOne({
        relationshipId,
        role: "assistant",
        mediaType: "audio",
        sequenceNumber: { $lt: currentSequence },
    }).sort({ sequenceNumber: -1 }).select("sequenceNumber").lean();
    if (!last) return false;
    const gap = await MessageModel.countDocuments({
        relationshipId,
        role: "assistant",
        sequenceNumber: { $gt: last.sequenceNumber, $lt: currentSequence },
    });
    return gap < VOICE_COOLDOWN_TURNS;
}

export async function attachCompanionVoice({
    relationshipId,
    assistantMessage,
    userText,
    replyText,
    intent,
    mediaProvider,
    storage,
}) {
    try {
        if (!assistantMessage?._id) return null;
        const asked = userAskedForVoice(userText);
        const rateLimited = await isVoiceRateLimited(relationshipId, assistantMessage.sequenceNumber);
        const decided = decideCompanionVoice({ intent, asked, rateLimited });
        if (!decided) return null;
        if (!mediaProvider?.synthesize || !storage?.upload) return null;

        let spoken = String(decided.spoken || replyText || "").trim().slice(0, 800);
        if (!spoken || looksLikeVoiceRefusal(spoken)) {
            spoken = decided.spoken && !looksLikeVoiceRefusal(decided.spoken)
                ? decided.spoken
                : "Hey, catching you on a voice note.";
        }
        spoken = spoken.slice(0, 800);
        if (!spoken) return null;

        const generated = await mediaProvider.synthesize({
            text: spoken,
            signal: AbortSignal.timeout(45_000),
        });
        if (!generated?.buffer) return null;
        const stored = await storage.upload({
            buffer: generated.buffer,
            mimeType: generated.mimeType || "audio/mpeg",
            folder: `messages/${relationshipId}`,
        });
        if (!stored?.url) return null;

        const mediaMeta = {
            mimeType: stored.mimeType || generated.mimeType || "audio/wav",
            size: stored.size,
            durationMs: estimateSpeechDurationMs(spoken),
            source: "generated",
            transcript: spoken,
        };

        await MessageModel.updateOne({ _id: assistantMessage._id }, {
            $set: {
                mediaUrl: stored.url,
                ...(stored.key ? { mediaKey: stored.key } : {}),
                mediaType: "audio",
                mediaMeta,
            },
        });
        return { ...stored, source: "generated" };
    } catch (error) {
        console.warn("[chat] companion voice skipped:", error?.message || error);
        return null;
    }
}
