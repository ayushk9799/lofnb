import { MessageModel } from "../models/message.model.js";
import { RelationshipModel } from "../models/relationship.model.js";

const PHOTO_TAG = /%%PHOTO(?:\s+\w+)?\s*\|\s*([^%\n]+)(?:\s*%%?)?/gi;
const PHOTO_COOLDOWN_TURNS = 3;
export const PHOTO_POLICIES = ["may_refuse", "send_when_asked"];
export const PHOTO_POLICY = "send_when_asked";
const LORE_STOP = new Set([
    "about", "and", "for", "from", "have", "just", "that", "the", "this",
    "what", "when", "with", "your", "you",
]);

export function extractPhotoIntent(text) {
    const raw = String(text || "");
    let query = null;
    const content = raw.replace(PHOTO_TAG, (_all, described) => {
        query = String(described || "").trim();
        return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
    return { content, intent: query ? { query } : null };
}

export function userAskedForPhoto(text) {
    const value = String(text || "");
    if (/\b(voice( ?note)?|audio|voicenote)\b/i.test(value)) return false;
    return (
        userAskedForPhotosTaken(value) ||
        /\b(send|show|share|drop|post)\b.{0,28}\b(pic|pics|photo|photos|picture|selfie|shot)\b/i.test(value) ||
        /\b(pic|photo|picture|selfie)\b.{0,20}\b(please|pls|of (it|that|this|you|your))\b/i.test(value) ||
        /\bwhat does (it|that|this) look like\b/i.test(value) ||
        /\bcan i see (it|that|this|you|a pic|a photo)\b/i.test(value) ||
        /\bwhere('?s| is) (it|the (pic|photo|picture))\b/i.test(value) ||
        /\b(send|show) it\b/i.test(value) ||
        /\bplease do it\b/i.test(value) ||
        /\bsend\b.{0,16}\bna\b/i.test(value)
    );
}

export function looksLikePhotoFollowUp(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    if (/\b(voice( ?note)?|audio|voicenote)\b/i.test(value)) return false;
    return (
        /^(please|pls|na|again|send|send na|come on|do it)[.!?]*$/i.test(value) ||
        /\bsend\b.{0,16}\b(na|pls|please|again)\b/i.test(value) ||
        /\b(pic|pics|photo|photos)\s*(na|pls|please)?[.!?]*$/i.test(value)
    );
}

export function userAskedForPhotosTaken(text) {
    const value = String(text || "");
    return (
        /\b(pic|pics|photo|photos|picture|shot|shots)\b.{0,48}\b(you('ve| have)? |u )?(taken|took|shot|captured)\b/i.test(value) ||
        /\b(taken|took|shot|captured)\b.{0,24}\b(by you|with your (camera|phone))\b/i.test(value) ||
        /\b(your|ur)\b.{0,20}\b(photography|portfolio)\b/i.test(value) ||
        /\b(from your (camera|shoot|lens))\b/i.test(value)
    );
}

export function userAskedForSelfie(text) {
    if (userAskedForPhotosTaken(text)) return false;
    const value = String(text || "");
    return (
        /\bselfie\b/i.test(value) ||
        /\b(pic|photo|picture)\b.{0,24}\bof (you|u|yourself)\b/i.test(value) ||
        /\b(your|ur)\b.{0,8}\b(selfie|face)\b/i.test(value) ||
        /\b(send|show|share|drop)\b.{0,20}\b(your|ur)\b.{0,10}\b(pic|photo|picture)s?\b/i.test(value)
    );
}

export function collectCameraRoll(character = {}, relationship = {}) {
    const seen = new Set();
    const items = [];
    const push = (item) => {
        const url = String(item?.url || "").trim();
        if (!url || seen.has(url)) return;
        seen.add(url);
        items.push({
            url,
            key: item.key,
            caption: item.caption,
        });
    };
    for (const item of relationship?.media?.gallery || []) push(item);
    for (const item of character?.gallery || []) push(item);
    for (const url of character?.photos || []) push({ url });
    if (character?.avatarUrl) push({ url: character.avatarUrl });
    return items;
}

export function matchGalleryPhoto(gallery = [], query = "") {
    const terms = String(query || "")
        .toLowerCase()
        .match(/[\p{L}\p{N}']+/gu)
        ?.filter((word) => word.length > 2 && !LORE_STOP.has(word)) || [];
    if (!gallery.length || !terms.length) return null;
    let best = null;
    let score = 0;
    for (const item of gallery) {
        if (!item?.url) continue;
        const hay = `${item.caption || ""}`.toLowerCase();
        const hits = terms.filter((word) => hay.includes(word)).length;
        if (hits > score) {
            score = hits;
            best = item;
        }
    }
    return score > 0 ? best : null;
}

export function pickCameraRollPhoto(roll = [], query = "") {
    return matchGalleryPhoto(roll, query) || roll[Math.floor(Math.random() * roll.length)] || null;
}

export function replyClaimsPhoto(text) {
    const value = String(text || "");
    return (
        /\bhere('s| is) (another|one|it|you go)\b/i.test(value) ||
        /\bhere you go\b/i.test(value) ||
        /\bdropped it\b/i.test(value) ||
        /\b(sending|sent) (it|this|a pic|a photo|one)\b/i.test(value) ||
        /\bthis one'?s from\b/i.test(value)
    );
}

export function replyRefusesPhoto(text) {
    const value = String(text || "");
    if (!value || replyClaimsPhoto(value)) return false;
    return (
        /\b(already sent|that's enough|that is enough|enough for now)\b/i.test(value) ||
        /\bi said no\b/i.test(value) ||
        /\brespect that\b/i.test(value) ||
        /\b(don't|do not|won't|will not|not gonna|not going to)\b.{0,40}\b(send|share|dump)\b.{0,32}\b(pic|pics|photo|photos|picture|roll|request)\b/i.test(value) ||
        /\bi don't send (pics|photos|pictures)\b/i.test(value) ||
        /\bno,?\s+i don't send\b/i.test(value) ||
        /\bstill no\b/i.test(value) ||
        /\bnot sending (a )?(personal )?(pic|photo|picture)/i.test(value)
    );
}

export async function countPriorPhotoRefusals(relationshipId, beforeSequence) {
    const recent = await MessageModel.find({
        relationshipId,
        role: "assistant",
        sequenceNumber: { $lt: beforeSequence },
        status: { $in: ["completed", "partial"] },
    }).sort({ sequenceNumber: -1 }).limit(16).select("content mediaType generation.mediaDecision").lean();
    return recent.filter((message) =>
        message.generation?.mediaDecision === "image_refused" ||
        (!message.mediaType && replyRefusesPhoto(message.content))
    ).length;
}

export function looksLikeVisualPhotoQuery(query, replyText = "") {
    const value = String(query || "").trim();
    if (!value || value.length > 180) return false;
    const reply = String(replyText || "").trim();
    if (reply && value.toLowerCase() === reply.toLowerCase()) return false;
    if (replyRefusesPhoto(value)) return false;
    if (/\b(don't send|do not send|that's enough|already sent|i said no)\b/i.test(value)) return false;
    return true;
}

export function photoQueryFromAsk(userText = "", fallback = "") {
    if (userAskedForSelfie(userText)) return "a candid photo of me";
    if (userAskedForPhotosTaken(userText)) return "a photo I took";
    const clean = String(fallback || "").trim();
    if (clean && looksLikeVisualPhotoQuery(clean)) return clean;
    return "a candid moment from my day";
}

function normalizePhotoPolicy(policy) {
    return policy === "send_when_asked" ? "send_when_asked" : "may_refuse";
}

export function decideCompanionPhoto({
    policy = PHOTO_POLICY,
    asked,
    claimed,
    toolIntent,
    userText = "",
    replyText = "",
    hasVoiceIntent = false,
    intent,
} = {}) {
    const hasContext = asked != null || claimed != null || Boolean(toolIntent) || Boolean(userText) || Boolean(replyText);
    if (!hasContext) {
        const query = String(intent?.query || "").trim();
        return query ? { query } : null;
    }

    const mode = normalizePhotoPolicy(policy);
    const userAsked = asked ?? userAskedForPhoto(userText);
    const didClaim = claimed ?? replyClaimsPhoto(replyText);
    const toolQuery = String(toolIntent?.query || intent?.query || "").trim();

    if (looksLikeVisualPhotoQuery(toolQuery, replyText)) return { query: toolQuery };
    // Infer send from what she did: called send_photo, or said she sent one.
    // No tool and no claim means she did not send, whatever wording she used.
    if (didClaim && !(hasVoiceIntent && !userAsked)) {
        return { query: photoQueryFromAsk(userText, toolQuery) };
    }
    if (userAsked && mode === "send_when_asked") {
        return { query: photoQueryFromAsk(userText, toolQuery) };
    }
    return null;
}

export function buildCompanionImagePrompt(character = {}, scene = "") {
    const visual = String(scene || "").trim();
    const looks = [
        character.appearanceLock || (character.ethnicity ? `${character.ethnicity} person` : ""),
        Number.isFinite(character.age) ? `about ${character.age}` : "",
    ].filter(Boolean).join(", ");
    return [
        "Exactly one smartphone photograph. Not a collage, not a grid, not multiple photos, no text overlay.",
        `The photo shows: ${visual || "a candid moment"}.`,
        looks ? `If the person in the photo is ${character.name || "the subject"}, they look like: ${looks}.` : "",
        "Slightly imperfect, natural light, looks like a real photo someone would text.",
    ].filter(Boolean).join(" ");
}

export async function isPhotoRateLimited(relationshipId, currentSequence) {
    const last = await MessageModel.findOne({
        relationshipId,
        role: "assistant",
        mediaType: "image",
        sequenceNumber: { $lt: currentSequence },
    }).sort({ sequenceNumber: -1 }).select("sequenceNumber").lean();
    if (!last) return false;
    const gap = await MessageModel.countDocuments({
        relationshipId,
        role: "assistant",
        sequenceNumber: { $gt: last.sequenceNumber, $lt: currentSequence },
    });
    return gap < PHOTO_COOLDOWN_TURNS;
}

export async function attachCompanionPhoto({
    relationshipId,
    assistantMessage,
    intent,
    mediaProvider,
    storage,
}) {
    try {
        if (!assistantMessage?._id) return null;
        const query = String(intent?.query || "").trim();
        if (!query) return null;

        const relationship = await RelationshipModel.findById(relationshipId).populate("characterId").lean();
        const character = relationship?.characterId;
        if (!character) return null;

        const roll = collectCameraRoll(character, relationship);
        const galleryHit = matchGalleryPhoto(roll, query);

        let stored = null;
        let source = "generated";
        let galleryCaption;
        if (galleryHit?.url) {
            stored = { url: galleryHit.url, key: galleryHit.key, mimeType: "image/jpeg" };
            source = "gallery";
            galleryCaption = galleryHit.caption;
        } else if (mediaProvider?.generateImage && storage?.upload) {
            const prompt = buildCompanionImagePrompt(character, query);
            const generated = await mediaProvider.generateImage({
                prompt,
                signal: AbortSignal.timeout(50_000),
            });
            if (!generated?.buffer) return null;
            stored = await storage.upload({
                buffer: generated.buffer,
                mimeType: generated.mimeType || "image/png",
                folder: `messages/${relationshipId}`,
            });
            source = "generated";
        }
        if (!stored?.url) return null;

        const mediaMeta = {
            mimeType: stored.mimeType,
            size: stored.size,
            source,
            prompt: source === "generated" ? query.slice(0, 500) : undefined,
            galleryCaption,
        };
        for (const key of Object.keys(mediaMeta)) {
            if (mediaMeta[key] == null || mediaMeta[key] === "") delete mediaMeta[key];
        }

        await MessageModel.updateOne({ _id: assistantMessage._id }, {
            $set: {
                mediaUrl: stored.url,
                ...(stored.key ? { mediaKey: stored.key } : {}),
                mediaType: "image",
                mediaMeta,
            },
        });
        return { ...stored, source };
    } catch (error) {
        console.warn("[chat] companion photo skipped:", error?.message || error);
        return null;
    }
}
