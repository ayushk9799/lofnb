/**
 * Attach a file only when Maya called a send tool (or claimed she sent a photo).
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
    toolText = false,
    userText = "",
    replyText = "",
    forceSend = false,
    canSendPhoto = true,
    canSendVoice = true,
} = {}) {
    const spoken = String(toolVoice?.spoken || "").trim();
    if (spoken) {
        return gateVoice({ photo: null, voice: { spoken: spoken.slice(0, 800) }, decision: "audio_sent" }, canSendVoice);
    }
    if (toolVoice?.action === "refuse") {
        return { photo: null, voice: null, decision: "audio_refused" };
    }
    if (toolPhoto?.action === "refuse" && !forceSend) {
        return { photo: null, voice: null, decision: "image_refused" };
    }
    const toolQuery = String(toolPhoto?.query || "").trim();
    if (looksLikeVisualPhotoQuery(toolQuery, replyText)) {
        return gatePhoto({ photo: { query: toolQuery }, voice: null, decision: "image_sent" }, canSendPhoto);
    }
    if (toolPhoto?.action === "refuse" && forceSend) {
        return gatePhoto({
            photo: { query: photoQueryFromAsk(userText, toolQuery) },
            voice: null,
            decision: "image_sent",
        }, canSendPhoto);
    }
    if (replyClaimsPhoto(replyText)) {
        return gatePhoto({
            photo: { query: photoQueryFromAsk(userText, toolQuery) },
            voice: null,
            decision: "image_sent",
        }, canSendPhoto);
    }
    if (toolText) {
        return { photo: null, voice: null, decision: "text" };
    }
    return { photo: null, voice: null, decision: "text" };
}

function gatePhoto(resolved, canSendPhoto) {
    if (canSendPhoto) return resolved;
    return { photo: null, voice: null, decision: "image_refused" };
}

function gateVoice(resolved, canSendVoice) {
    if (canSendVoice) return resolved;
    return { photo: null, voice: null, decision: "audio_refused" };
}
