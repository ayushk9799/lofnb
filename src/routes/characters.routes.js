import { Router } from "express";
import { CharacterModel } from "../models/character.model.js";
import { requireObjectId } from "../middleware/error-handler.js";
import { HttpError } from "../utils/http-error.js";

function formatCharacter(character) {
    const photos = Array.isArray(character.photos) && character.photos.length > 0
        ? character.photos
        : (character.avatarUrl ? [character.avatarUrl] : []);
    return {
        ...character,
        photos,
    };
}

export const charactersRouter = Router();

charactersRouter.get("/", async (_request, response) => {
    const characters = await CharacterModel.find()
        .sort({ name: 1 })
        .select("slug name age avatarUrl photos gallery occupation location hobbies persona.summary persona.personalityTraits persona.values persona.boundaries")
        .lean();
    response.json({ data: characters.map(formatCharacter) });
});

charactersRouter.get("/:characterId", async (request, response) => {
    const characterId = requireObjectId(String(request.params.characterId || ""), "characterId");
    const character = await CharacterModel.findById(characterId).lean();
    if (!character)
        throw new HttpError(404, "Character not found", "NOT_FOUND");
    response.json({ data: formatCharacter(character) });
});

// Add multiple photos to a character (like Telegram profile photos)
charactersRouter.post("/:characterId/photos", async (request, response) => {
    const characterId = requireObjectId(String(request.params.characterId || ""), "characterId");
    const { url, urls, caption } = request.body || {};
    const toAdd = Array.isArray(urls) ? urls : url ? [url] : [];
    if (toAdd.length === 0) {
        throw new HttpError(400, "At least one photo URL is required", "BAD_REQUEST");
    }
    const character = await CharacterModel.findById(characterId);
    if (!character)
        throw new HttpError(404, "Character not found", "NOT_FOUND");

    if (!Array.isArray(character.photos)) character.photos = [];
    if (!Array.isArray(character.gallery)) character.gallery = [];

    for (const u of toAdd) {
        if (typeof u === "string" && u.trim()) {
            character.photos.push(u.trim());
            character.gallery.push({ url: u.trim(), caption: caption || "" });
        }
    }
    await character.save();
    response.status(201).json({ data: formatCharacter(character.toObject()) });
});

// Remove a photo from a character by index
charactersRouter.delete("/:characterId/photos/:photoIndex", async (request, response) => {
    const characterId = requireObjectId(String(request.params.characterId || ""), "characterId");
    const index = parseInt(request.params.photoIndex, 10);
    const character = await CharacterModel.findById(characterId);
    if (!character)
        throw new HttpError(404, "Character not found", "NOT_FOUND");

    const allPhotos = Array.isArray(character.photos) && character.photos.length > 0
        ? character.photos
        : [character.avatarUrl, ...(character.gallery || []).map(g => g.url)].filter(Boolean);

    if (isNaN(index) || index < 0 || index >= allPhotos.length) {
        throw new HttpError(400, "Invalid photo index", "BAD_REQUEST");
    }
    const removedUrl = allPhotos[index];
    character.photos = allPhotos.filter((_, i) => i !== index);
    if (Array.isArray(character.gallery)) {
        character.gallery = character.gallery.filter(g => g.url !== removedUrl);
    }
    await character.save();
    response.json({ data: formatCharacter(character.toObject()) });
});

// Reorder photos of a character
charactersRouter.put("/:characterId/photos/reorder", async (request, response) => {
    const characterId = requireObjectId(String(request.params.characterId || ""), "characterId");
    const { order } = z.object({ order: z.array(z.number().int().min(0)) }).parse(request.body || {});
    const character = await CharacterModel.findById(characterId);
    if (!character)
        throw new HttpError(404, "Character not found", "NOT_FOUND");

    const allPhotos = Array.isArray(character.photos) && character.photos.length > 0
        ? character.photos
        : [character.avatarUrl, ...(character.gallery || []).map(g => g.url)].filter(Boolean);

    const reordered = [];
    for (const oldIndex of order) {
        if (allPhotos[oldIndex] && !reordered.includes(allPhotos[oldIndex])) {
            reordered.push(allPhotos[oldIndex]);
        }
    }
    allPhotos.forEach(p => {
        if (!reordered.includes(p)) reordered.push(p);
    });
    character.photos = reordered;
    if (reordered[0]) character.avatarUrl = reordered[0];
    await character.save();
    response.json({ data: formatCharacter(character.toObject()) });
});

// Replace or set photo at specific index of a character
charactersRouter.put("/:characterId/photos/:photoIndex", async (request, response) => {
    const characterId = requireObjectId(String(request.params.characterId || ""), "characterId");
    const index = parseInt(request.params.photoIndex, 10);
    const { url, caption } = z.object({ url: z.string().url(), caption: z.string().max(240).optional() }).parse(request.body || {});
    const character = await CharacterModel.findById(characterId);
    if (!character)
        throw new HttpError(404, "Character not found", "NOT_FOUND");

    if (!Array.isArray(character.photos)) character.photos = [];
    if (!Array.isArray(character.gallery)) character.gallery = [];

    if (isNaN(index) || index < 0 || index > character.photos.length) {
        throw new HttpError(400, "Invalid photo index", "BAD_REQUEST");
    }

    if (index === character.photos.length) {
        character.photos.push(url);
    } else {
        character.photos[index] = url;
    }

    if (index === 0) {
        character.avatarUrl = url;
    }
    character.gallery.push({ url, caption: caption || "" });

    await character.save();
    response.json({ data: formatCharacter(character.toObject()) });
});

