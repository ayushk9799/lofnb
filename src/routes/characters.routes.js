import { Router } from "express";
import { CharacterModel } from "../models/character.model.js";
import { requireObjectId } from "../middleware/error-handler.js";
import { HttpError } from "../utils/http-error.js";
export const charactersRouter = Router();
charactersRouter.get("/", async (_request, response) => {
    const characters = await CharacterModel.find()
        .sort({ name: 1 })
        .select("slug name age avatarUrl gallery persona.summary persona.personalityTraits")
        .lean();
    response.json({ data: characters });
});
charactersRouter.get("/:characterId", async (request, response) => {
    const characterId = requireObjectId(String(request.params.characterId || ""), "characterId");
    const character = await CharacterModel.findById(characterId).lean();
    if (!character)
        throw new HttpError(404, "Character not found", "NOT_FOUND");
    response.json({ data: character });
});
