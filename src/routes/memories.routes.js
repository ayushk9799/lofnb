import { Router } from "express";
import { z } from "zod";
import { MemoryModel } from "../models/memory.model.js";
import { requireObjectId } from "../middleware/error-handler.js";
import { requireOwnedRelationship } from "../services/relationship.service.js";
import { forgetMemory } from "../services/forget-memory.service.js";
const memoryQuery = z.object({
    status: z.enum(["active", "superseded", "deleted"]).default("active"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const memoriesRouter = Router({ mergeParams: true });
memoriesRouter.get("/", async (request, response) => {
    const relationshipId = requireObjectId(request.params.relationshipId, "relationshipId");
    await requireOwnedRelationship(relationshipId, request.auth.userId);
    const query = memoryQuery.parse(request.query);
    const memories = await MemoryModel.find({
        relationshipId,
        userId: request.auth.userId,
        status: query.status,
    })
        .sort({ importance: -1, updatedAt: -1 })
        .limit(query.limit)
        .select("type text normalizedKey confidence importance status sourceMessageIds updatedAt")
        .lean();
    response.json({ data: memories });
});
memoriesRouter.delete("/:memoryId", async (request, response) => {
    const relationshipId = requireObjectId(request.params.relationshipId, "relationshipId");
    const memoryId = requireObjectId(request.params.memoryId, "memoryId");
    await forgetMemory({relationshipId, userId: request.auth.userId, memoryId});
    response.status(204).end();
});
