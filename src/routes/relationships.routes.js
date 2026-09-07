import { Router } from "express";
import { z } from "zod";
import { CharacterModel } from "../models/character.model.js";
import { MemoryJobModel } from "../models/memory-job.model.js";
import { MessageModel } from "../models/message.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { requireObjectId } from "../middleware/error-handler.js";
import { requireOwnedRelationship } from "../services/relationship.service.js";
import { HttpError } from "../utils/http-error.js";
const createRelationship = z.object({
    characterId: z.string().min(1),
});
const messageQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const relationshipsRouter = Router();
relationshipsRouter.get("/", async (request, response) => {
    const relationships = await RelationshipModel.find({ userId: request.auth.userId })
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .populate("characterId", "slug name age avatarUrl ethnicity occupation location gallery persona.summary persona.personalityTraits hobbies")
        .lean();
    response.json({ data: relationships });
});
relationshipsRouter.post("/", async (request, response) => {
    const body = createRelationship.parse(request.body);
    const characterId = requireObjectId(body.characterId, "characterId");
    const characterExists = await CharacterModel.exists({ _id: characterId });
    if (!characterExists)
        throw new HttpError(404, "Character not found", "NOT_FOUND");
    const relationship = await RelationshipModel.findOneAndUpdate({ userId: request.auth.userId, characterId }, {
        $setOnInsert: {
            userId: request.auth.userId,
            characterId,
            stage: "new",
            mood: "neutral",
        },
    }, { new: true, upsert: true, setDefaultsOnInsert: true }).populate("characterId", "slug name age avatarUrl ethnicity occupation location gallery persona.summary persona.personalityTraits hobbies");
    response.status(201).json({ data: relationship });
});
relationshipsRouter.get("/:relationshipId", async (request, response) => {
    const relationshipId = requireObjectId(request.params.relationshipId, "relationshipId");
    const relationship = await requireOwnedRelationship(relationshipId, request.auth.userId);
    await relationship.populate("characterId");
    response.json({ data: relationship });
});
relationshipsRouter.get("/:relationshipId/messages", async (request, response) => {
    const relationshipId = requireObjectId(request.params.relationshipId, "relationshipId");
    await requireOwnedRelationship(relationshipId, request.auth.userId);
    const query = messageQuery.parse(request.query);
    const filter = { relationshipId };
    if (query.before)
        filter.sequenceNumber = { $lt: query.before };
    const messages = await MessageModel.find(filter)
        .sort({ sequenceNumber: -1 })
        .limit(query.limit)
        .select("sequenceNumber role content status createdAt completedAt")
        .lean();
    response.json({ data: messages.reverse() });
});

relationshipsRouter.get("/:relationshipId/memory-status", async (request, response) => {
    const relationshipId = requireObjectId(request.params.relationshipId, "relationshipId");
    await requireOwnedRelationship(relationshipId, request.auth.userId);
    const [jobs, unscheduled, failed] = await Promise.all([
        MemoryJobModel.countDocuments({relationshipId, status: {$in: ["pending", "processing"]}}),
        MessageModel.countDocuments({relationshipId, status:"completed", memoryPending:true}),
        MemoryJobModel.countDocuments({relationshipId, status:"failed"}),
    ]);
    response.json({data: {pending: jobs + unscheduled, failed}});
});
