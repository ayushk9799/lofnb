import { MessageModel } from "../models/message.model.js";
import { RelationshipModel } from "../models/relationship.model.js";

const PHOTO_TAG = /%%PHOTO\s+(gallery|scene)\s*\|\s*([^%\n]+)(?:\s*%%?)?/gi;
const PHOTO_COOLDOWN_TURNS = 3;
const LORE_STOP = new Set([
    "about", "and", "for", "from", "have", "just", "that", "the", "this",
    "what", "when", "with", "your", "you",
]);

export function extractPhotoIntent(text) {
    const raw = String(text || "");
    let intent = null;
    const content = raw.replace(PHOTO_TAG, (_all, kind, query) => {
        intent = { kind: String(kind).toLowerCase(), query: String(query || "").trim() };
        return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
    return { content, intent };
}

export function userAskedForPhoto(text) {
    const value = String(text || "");
    return (
        /\b(send|show|share|drop|post)\b.{0,28}\b(pic|pics|photo|photos|picture|selfie|shot)\b/i.test(value) ||
        /\b(pic|photo|picture|selfie)\b.{0,20}\b(please|pls|of (it|that|this|you|your))\b/i.test(value) ||
        /\bwhat does (it|that|this) look like\b/i.test(value) ||
        /\bcan i see (it|that|this|you|a pic|a photo)\b/i.test(value)
    );
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

export function decideCompanionPhoto({ intent, asked, rateLimited }) {
    if (rateLimited && !asked) return null;
    if (intent?.query) return intent;
    if (asked) return { kind: "scene", query: "" };
    return null;
}

export function buildCompanionImagePrompt(character = {}, scene = "") {
    const looks = [
        character.ethnicity ? `${character.ethnicity} person` : "",
        Number.isFinite(character.age) ? `about ${character.age}` : "",
        character.occupation || "",
    ].filter(Boolean).join(", ");
    const captions = (character.gallery || [])
        .map((item) => item?.caption)
        .filter(Boolean)
        .slice(0, 3)
        .join("; ");
    const visual = String(scene || "").trim() || "a candid moment from their day";
    return [
        "Candid smartphone photo, slightly imperfect, natural light, not cinematic, not illustrated, no text overlay.",
        `Subject: ${character.name || "the person"}${looks ? `, ${looks}` : ""}.`,
        captions ? `Appearance cues: ${captions}.` : "",
        `Scene: ${visual}.`,
        "Looks like a real photo from a camera roll that someone would text.",
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
    userText,
    replyText,
    intent,
    mediaProvider,
    storage,
}) {
    try {
        if (!assistantMessage?._id) return null;
        const asked = userAskedForPhoto(userText);
        const rateLimited = await isPhotoRateLimited(relationshipId, assistantMessage.sequenceNumber);
        const decided = decideCompanionPhoto({ intent, asked, rateLimited });
        if (!decided) return null;

        const relationship = await RelationshipModel.findById(relationshipId).populate("characterId").lean();
        const character = relationship?.characterId;
        if (!character) return null;

        const gallery = [
            ...(Array.isArray(relationship.media?.gallery) ? relationship.media.gallery : []),
            ...(Array.isArray(character.gallery) ? character.gallery : []),
        ];
        const query = decided.query || replyText || userText || "";
        const galleryHit = matchGalleryPhoto(gallery, query);

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
