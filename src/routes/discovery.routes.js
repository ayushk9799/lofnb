import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { RelationshipModel } from "../models/relationship.model.js";
import { SwipeModel } from "../models/swipe.model.js";
import { UserModel } from "../models/user.model.js";
import { CharacterModel } from "../models/character.model.js";
import { requireObjectId } from "../middleware/error-handler.js";

const discoveryQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function formatCharacter(character) {
  const photos =
    Array.isArray(character.photos) && character.photos.length > 0
      ? character.photos
      : character.avatarUrl
        ? [character.avatarUrl]
        : [];
  return { ...character, photos };
}

export const discoveryRouter = Router();

discoveryRouter.get("/", async (request, response) => {
  const { cursor, limit } = discoveryQuery.parse(request.query);
  const userId = request.auth.userId;
  const profile = await UserModel.findOne({ userId })
    .select("vibe minAge maxAge interestedIn")
    .lean();
  const minAge = profile?.minAge ?? 18;
  const maxAge = profile?.maxAge ?? 60;
  const vibe = profile?.vibe ?? "Everyone";

  const characterMatch = {
    age: { $gte: minAge, $lte: maxAge },
  };
  if (Array.isArray(profile?.interestedIn) && profile.interestedIn.length > 0) {
    characterMatch.gender = { $in: profile.interestedIn };
  }
  if (cursor) {
    characterMatch._id = {
      $gt: new Types.ObjectId(requireObjectId(cursor, "cursor")),
    };
  }

  const pipeline = [{ $match: characterMatch }];
  if (vibe !== "Everyone") {
    pipeline.push({
      $match: {
        $expr: {
          $in: [
            vibe.toLowerCase(),
            {
              $map: {
                input: { $ifNull: ["$persona.personalityTraits", []] },
                as: "trait",
                in: { $toLower: "$$trait" },
              },
            },
          ],
        },
      },
    });
  }
  pipeline.push(
    { $sort: { _id: 1 } },
    {
      $lookup: {
        from: SwipeModel.collection.name,
        let: { characterId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$userId", userId] },
                  { $eq: ["$characterId", "$$characterId"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "userSwipe",
      },
    },
    { $match: { "userSwipe.0": { $exists: false } } },
    {
      $lookup: {
        from: RelationshipModel.collection.name,
        let: { characterId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$userId", userId] },
                  { $eq: ["$characterId", "$$characterId"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "userRelationship",
      },
    },
    { $match: { "userRelationship.0": { $exists: false } } },
    { $limit: limit + 1 },
    {
      $project: {
        slug: 1,
        name: 1,
        age: 1,
        gender: 1,
        avatarUrl: 1,
        photos: 1,
        gallery: 1,
        occupation: 1,
        location: 1,
        hobbies: 1,
        "persona.summary": 1,
        "persona.personalityTraits": 1,
        "persona.values": 1,
        "persona.boundaries": 1,
      },
    },
  );

  const rows = await CharacterModel.aggregate(pipeline);
  const hasMore = rows.length > limit;
  const profiles = rows.slice(0, limit).map(formatCharacter);
  response.json({
    data: {
      profiles,
      hasMore,
      nextCursor: hasMore ? String(profiles.at(-1)._id) : null,
    },
  });
});
