/**
 * Maya classifies the turn with tools. Backend attaches a file only on send.
 */

import { looksLikeVisualPhotoQuery, photoQueryFromAsk, replyClaimsPhoto } from "./companion-photo.service.js";

export function visibleTurnContent(content = "", mediaType, mediaDecision) {
    const text = String(content || "").trim();
    if (mediaType === "image" || mediaDecision === "image_sent") {
        return text ? `${text} [sent a photo]` : "[sent a photo]";
    }
    if (mediaType === "audio" || mediaDecision === "audio_sent") {
        return text ? `${text} [sent a voice note]` : "[sent a voice note]";
    }
    if (mediaDecision === "image_refused") {
        return text ? `${text} [refused a photo]` : "[refused a photo]";
    }
    if (mediaDecision === "audio_refused") {
        return text ? `${text} [refused a voice note]` : "[refused a voice note]";
    }
    return text;
}

export function resolveCompanionMedia({
    toolPhoto,
    toolVoice,
    userText = "",
    replyText = "",
    photoNeeded = false,
    voiceNeeded = false,
} = {}) {
    if (toolPhoto?.action === "refuse") {
        return { photo: null, voice: null, decision: "image_refused" };
    }
    const toolQuery = String(toolPhoto?.query || "").trim();
    if (looksLikeVisualPhotoQuery(toolQuery, replyText)) {
        return { photo: { query: toolQuery }, voice: null, decision: "image_sent" };
    }
    if (replyClaimsPhoto(replyText) && toolVoice?.action !== "send") {
        return {
            photo: { query: photoQueryFromAsk(userText, toolQuery) },
            voice: null,
            decision: "image_sent",
        };
    }
    if (photoNeeded) {
        return { photo: null, voice: null, decision: "image_refused" };
    }
    if (toolVoice?.action === "refuse") {
        return { photo: null, voice: null, decision: "audio_refused" };
    }
    const spoken = String(toolVoice?.spoken || "").trim();
    if (spoken) {
        return { photo: null, voice: { spoken: spoken.slice(0, 800) }, decision: "audio_sent" };
    }
    if (voiceNeeded) {
        return { photo: null, voice: null, decision: "audio_refused" };
    }
    return { photo: null, voice: null, decision: "text" };
}
