import { MessageModel } from "../models/message.model.js";

const VOICE_TAG = /%%VOICE(?:\s*\|\s*([^%\n]+))?(?:\s*%%?)?/gi;
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

// When the LLM didn't write specific voice content, build a natural voice memo
// that's different from the text reply — like a real person leaving a voice message.
function buildVoiceMemoFallback(replyText, userText) {
    const reply = String(replyText || "").trim();
    const user = String(userText || "").trim().toLowerCase();

    // Late night / early morning context
    if (/\b(tired|sleep|bed|night|morning|can't sleep|insomnia)\b/.test(user)) {
        return `Okay so I'm actually lying down right now but I wanted to send you a proper voice note instead of just typing. ${reply} Anyway, talk soon.`;
    }

    // Emotional / vulnerable
    if (/\b(rough|bad day|awful|stressed|overwhelmed|sad|crying|hurt)\b/.test(user)) {
        return `Hey, I just wanted to actually say this out loud instead of typing it. ${reply} I mean it though, for real.`;
    }

    // Excited
    if (/\b(yay|omg|got it|passed|won|finally|congrats)\b/.test(user)) {
        return `Okay I had to send a voice note for this one, typing doesn't do it justice. ${reply} Seriously though, that's amazing.`;
    }

    // Default: natural voice memo that expands on the reply
    return `Hey, so ${reply} I just felt like actually talking for a second instead of typing everything out. Anyway, what's up with you?`;
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

        let spoken = String(decided.spoken || "").trim().slice(0, 800);
        const replyClean = String(replyText || "").trim();

        // If the LLM didn't provide specific voice content, don't just read the text reply.
        // Generate a natural voice memo based on the conversation context.
        if (!spoken || looksLikeVoiceRefusal(spoken)) {
            if (decided.spoken && !looksLikeVoiceRefusal(decided.spoken)) {
                spoken = decided.spoken;
            } else if (replyClean) {
                // Build a natural voice memo that's different from the text reply.
                spoken = buildVoiceMemoFallback(replyClean, userText);
            } else {
                spoken = "Hey, just wanted to say hi properly. Can't always type everything out, you know?";
            }
        }
        // Enforce a minimum so we don't send 1-word voice notes.
        if (spoken.split(/\s+/).length < 5) {
            spoken = `${spoken}. Anyway, just wanted to actually talk for a second instead of typing.`;
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
