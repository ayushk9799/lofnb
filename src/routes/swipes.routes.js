import { Router } from "express";
import { z } from "zod";
import { CharacterModel } from "../models/character.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { SwipeModel } from "../models/swipe.model.js";
import { requireObjectId } from "../middleware/error-handler.js";
import { HttpError } from "../utils/http-error.js";

const createSwipe = z.object({
    characterId: z.string().min(1),
    clientSwipeId: z.string().min(8).max(160),
    direction: z.enum(["like", "pass"]),
    occurredAt: z.iso.datetime().optional(),
});

// The companion texts first, a little while after the match, so the reward
// for a like is her message rather than a poster. Only a few recent matches
// get one so a burst of likes does not become a burst of pushes.
export const OPENER_MIN_DELAY_MS = 15_000;
export const OPENER_MAX_DELAY_MS = 180_000;
export const OPENER_MAX_PENDING = 3;

function openerDelayMs() {
    return OPENER_MIN_DELAY_MS + Math.floor(Math.random() * (OPENER_MAX_DELAY_MS - OPENER_MIN_DELAY_MS));
}

async function scheduleOpener(relationshipId, userId) {
    const pending = await RelationshipModel.countDocuments({
        userId,
        openerDueAt: { $exists: true },
        openerSentAt: { $exists: false },
    });
    if (pending >= OPENER_MAX_PENDING) return;
    await RelationshipModel.updateOne(
        { _id: relationshipId, openerDueAt: { $exists: false }, openerSentAt: { $exists: false } },
        { $set: { openerDueAt: new Date(Date.now() + openerDelayMs()) } },
    );
}

async function ensureRelationship(swipe, characterId, userId) {
    if (swipe.outcome !== "matched") return null;
    const now = new Date();
    const existing = await RelationshipModel.exists({ userId, characterId });
    const relationship = await RelationshipModel.findOneAndUpdate(
        { userId, characterId },
        {
            $setOnInsert: {
                userId,
                characterId,
                stage: "new",
                mood: "neutral",
                matchedAt: now,
            },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
    ).populate(
        "characterId",
        "slug name age avatarUrl photos ethnicity occupation location gallery persona.summary persona.personalityTraits persona.values persona.boundaries hobbies",
    );
    if (!swipe.relationshipId) {
        await SwipeModel.updateOne(
            { _id: swipe._id, relationshipId: { $exists: false } },
            { $set: { relationshipId: relationship._id } },
        );
    }
    if (!existing) {
        await scheduleOpener(relationship._id, userId).catch(error =>
            console.warn("[swipes] opener scheduling deferred:", error.message),
        );
    }
    return relationship;
}

export const swipesRouter = Router();

swipesRouter.post("/", async (request, response) => {
    const body = createSwipe.parse(request.body);
    const characterId = requireObjectId(body.characterId, "characterId");
    const userId = request.auth.userId;

    const previous = await SwipeModel.findOne({
        userId,
        $or: [
            { clientSwipeId: body.clientSwipeId },
            { characterId },
        ],
    });
    if (previous) {
        if (
            previous.clientSwipeId === body.clientSwipeId &&
            (String(previous.characterId) !== String(characterId) || previous.direction !== body.direction)
        ) {
            throw new HttpError(409, "clientSwipeId was already used for another swipe", "SWIPE_CONFLICT");
        }
        const relationship = await ensureRelationship(previous, previous.characterId, userId);
        return response.json({
            data: {
                swipeId: String(previous._id),
                outcome: previous.outcome,
                match: relationship,
            },
        });
    }

    const character = await CharacterModel.findById(characterId)
        .select("matchProbability")
        .lean();
    if (!character) {
        throw new HttpError(404, "Character not found", "NOT_FOUND");
    }

    const probability = character.matchProbability ?? request.app.locals.matchRate;
    const outcome =
        body.direction === "like" && Math.random() < probability
            ? "matched"
            : "recorded";

    let swipe;
    try {
        swipe = await SwipeModel.create({
            userId,
            characterId,
            clientSwipeId: body.clientSwipeId,
            direction: body.direction,
            outcome,
            occurredAt: body.occurredAt,
        });
    } catch (error) {
        if (error?.code !== 11000) throw error;
        swipe = await SwipeModel.findOne({
            userId,
            $or: [
                { clientSwipeId: body.clientSwipeId },
                { characterId },
            ],
        });
    }

    const relationship = await ensureRelationship(swipe, characterId, userId);
    response.status(201).json({
        data: {
            swipeId: String(swipe._id),
            outcome: swipe.outcome,
            match: relationship,
        },
    });
});
