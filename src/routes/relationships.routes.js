import { Router } from "express";
import { z } from "zod";
import { CharacterModel } from "../models/character.model.js";
import { MemoryJobModel } from "../models/memory-job.model.js";
import { MessageModel } from "../models/message.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { UserModel } from "../models/user.model.js";
import { requireObjectId } from "../middleware/error-handler.js";
import { requireOwnedRelationship } from "../services/relationship.service.js";
import { unlockCompanionMedia } from "../services/companion-photo.service.js";
import { CurrencyService } from "../services/currency.service.js";
import { attachCompanionAvailability } from "../services/chat-quota.service.js";
import { HttpError } from "../utils/http-error.js";
const createRelationship = z.object({
    characterId: z.string().min(1),
});
const messageQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    after: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine(data => !(data.before !== undefined && data.after !== undefined), {
    message: "Cannot specify both 'before' and 'after'",
});
const markReadBody = z.object({
    sequenceNumber: z.number().int().min(0).optional(),
});

export const relationshipsRouter = Router();
relationshipsRouter.get("/", async (request, response) => {
    const relationships = await RelationshipModel.find({ userId: request.auth.userId })
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .populate("characterId", "slug name age avatarUrl photos ethnicity occupation location gallery persona.summary persona.personalityTraits persona.values persona.boundaries hobbies")
        .lean();
    const relationshipsWithUnread = await Promise.all(
        relationships.map(async (rel) => {
            const unreadCount = await MessageModel.countDocuments({
                relationshipId: rel._id,
                role: "assistant",
                sequenceNumber: { $gt: rel.userLastReadSequence || 0 },
            });
            return { ...rel, unreadCount };
        })
    );
    const data = await attachCompanionAvailability(
        request.auth.userId,
        relationshipsWithUnread,
        request.app?.locals?.env,
    );
    response.json({ data });
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
    }, { new: true, upsert: true, setDefaultsOnInsert: true }).populate("characterId", "slug name age avatarUrl photos ethnicity occupation location gallery persona.summary persona.personalityTraits persona.values persona.boundaries hobbies");
    const payload = typeof relationship.toObject === "function" ? relationship.toObject() : relationship;
    const [data] = await attachCompanionAvailability(
        request.auth.userId,
        [payload],
        request.app?.locals?.env,
    );
    response.status(201).json({ data });
});
relationshipsRouter.get("/:relationshipId", async (request, response) => {
    const relationshipId = requireObjectId(request.params.relationshipId, "relationshipId");
    const relationship = await requireOwnedRelationship(relationshipId, request.auth.userId);
    await relationship.populate("characterId");
    const payload = typeof relationship.toObject === "function"
        ? relationship.toObject()
        : relationship;
    const [data] = await attachCompanionAvailability(
        request.auth.userId,
        [payload],
        request.app?.locals?.env,
    );
    response.json({ data });
});
relationshipsRouter.post("/:relationshipId/read", async (request, response) => {
    const relationshipId = requireObjectId(request.params.relationshipId, "relationshipId");
    await requireOwnedRelationship(relationshipId, request.auth.userId);
    const body = markReadBody.parse(request.body || {});
    let targetSequence = body.sequenceNumber;
    if (targetSequence === undefined) {
        const latestMsg = await MessageModel.findOne({ relationshipId })
            .sort({ sequenceNumber: -1 })
            .select("sequenceNumber")
            .lean();
        targetSequence = latestMsg ? latestMsg.sequenceNumber : 0;
    }
    const now = new Date();
    const updated = await RelationshipModel.findByIdAndUpdate(
        relationshipId,
        {
            $max: { userLastReadSequence: targetSequence },
            $set: { userLastReadAt: now },
        },
        { new: true }
    ).select("userLastReadSequence userLastReadAt companionLastReadSequence companionLastReadAt");

    await MessageModel.updateMany(
        {
            relationshipId,
            role: "assistant",
            sequenceNumber: { $lte: targetSequence },
            readAt: { $exists: false },
        },
        { $set: { readAt: now } }
    );

    response.json({
        data: {
            userLastReadSequence: updated.userLastReadSequence,
            userLastReadAt: updated.userLastReadAt,
        },
    });
});
relationshipsRouter.get("/:relationshipId/messages", async (request, response) => {
    const relationshipId = requireObjectId(request.params.relationshipId, "relationshipId");
    await requireOwnedRelationship(relationshipId, request.auth.userId);
    const query = messageQuery.parse(request.query);
    const filter = { relationshipId };
    const select = "sequenceNumber role content bubbles status createdAt completedAt readAt mediaUrl mediaKey mediaType mediaMeta clientMessageId";
    if (query.after !== undefined) {
        filter.sequenceNumber = { $gt: query.after };
        const messages = await MessageModel.find(filter)
            .sort({ sequenceNumber: 1 })
            .limit(query.limit)
            .select(select)
            .lean();
        response.json({ data: messages });
        return;
    }
    if (query.before)
        filter.sequenceNumber = { $lt: query.before };
    const messages = await MessageModel.find(filter)
        .sort({ sequenceNumber: -1 })
        .limit(query.limit)
        .select(select)
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

function revenueCatCustomerId(user, fallbackUserId) {
    return user?.revenueCatAppUserId || user?.accountId || fallbackUserId;
}

export function createRelationshipsRouter({ env } = {}) {
    const router = Router();
    const currencyService = new CurrencyService(env);
    router.use(relationshipsRouter);
    router.post("/:relationshipId/messages/:messageId/unlock", async (request, response) => {
        const relationshipId = requireObjectId(request.params.relationshipId, "relationshipId");
        const messageId = requireObjectId(request.params.messageId, "messageId");
        const userId = request.auth?.userId;
        if (!userId) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
        const user = await UserModel.findOne({ userId }).lean();
        if (!user) throw new HttpError(404, "User not found", "USER_NOT_FOUND");
        const result = await unlockCompanionMedia({
            relationshipId,
            messageId,
            userId,
            currencyService,
            customerId: revenueCatCustomerId(user, userId),
        });
        const payload = {
            success: true,
            spent: result.spent,
            remainingGems: result.remainingGems,
            alreadyUnlocked: result.alreadyUnlocked,
            mediaMeta: result.mediaMeta,
        };
        response.json({ ...payload, data: payload });
    });
    return router;
}
