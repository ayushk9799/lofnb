import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { UserModel } from "../models/user.model.js";
import { MessageModel } from "../models/message.model.js";
import { MemoryModel } from "../models/memory.model.js";
import { MemoryJobModel } from "../models/memory-job.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { SwipeModel } from "../models/swipe.model.js";
import { HttpError } from "../utils/http-error.js";
import { grantWelcomeHeartsIfEligible } from "../services/welcome-hearts.service.js";
import { upload } from "../middleware/upload.js";

const updateProfileSchema = z.object({
    name: z.string().max(80).optional(),
    age: z.coerce.number().int().min(18).max(120).optional(),
    bio: z.string().max(500).optional(),
    avatarUrl: z.string().max(2048).optional(),
    vibe: z.enum(["Everyone", "Creative", "Playful", "Warm", "Curious", "Adventurous"]).optional(),
    minAge: z.coerce.number().int().min(18).max(100).optional(),
    maxAge: z.coerce.number().int().min(18).max(100).optional(),
    timezone: z.string().max(100).optional(),
    completeOnboarding: z.boolean().optional(),
}).refine(data => {
    if (data.minAge !== undefined && data.maxAge !== undefined) {
        return data.minAge <= data.maxAge;
    }
    return true;
}, {
    message: "minAge cannot exceed maxAge",
    path: ["minAge"],
});

export const profileRouter = Router();

async function cleanStorage(request, key) {
    const sanitizedUserId = request.auth.userId.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (key && typeof key === "string" && key.startsWith(`users/${sanitizedUserId}/`)) {
        await request.app.locals.storage.delete(key).catch(() => console.warn("User avatar cleanup deferred"));
    }
}

profileRouter.get("/", async (request, response) => {
    let profile = await UserModel.findOne({ userId: request.auth.userId }).lean();
    if (!profile) {
        profile = {
            userId: request.auth.userId,
            name: "",
            age: null,
            bio: "",
            avatarUrl: "",
            vibe: "Everyone",
            minAge: 18,
            maxAge: 60,
            timezone: "",
            onboardedAt: null,
        };
    }
    response.json({ data: profile });
});

async function handleUpdate(request, response) {
    const body = updateProfileSchema.parse(request.body);
    const { completeOnboarding, ...profileFields } = body;
    const existing = await UserModel.findOne({ userId: request.auth.userId });
    const minAge = body.minAge ?? existing?.minAge ?? 18;
    const maxAge = body.maxAge ?? existing?.maxAge ?? 60;
    if (minAge > maxAge) {
        throw new HttpError(400, "minAge cannot exceed maxAge", "VALIDATION_ERROR");
    }

    const $set = {
        ...profileFields,
        userId: request.auth.userId,
    };
    if (completeOnboarding && !existing?.onboardedAt) {
        $set.onboardedAt = new Date();
    }

    const profile = await UserModel.findOneAndUpdate(
        { userId: request.auth.userId },
        { $set },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    if (completeOnboarding && !existing?.onboardedAt) {
        try {
            await grantWelcomeHeartsIfEligible({
                userId: request.auth.userId,
                env: request.app?.locals?.env,
            });
        } catch (error) {
            console.warn("[WelcomeHearts] Grant after onboarding deferred:", error.message);
        }
    }
    response.json({ data: profile });
}

profileRouter.patch("/", handleUpdate);
profileRouter.put("/", handleUpdate);

// Upload or replace the user's single avatar picture
profileRouter.post("/avatar", upload.single("avatar"), async (request, response) => {
    if (!request.file || !request.file.mimetype.startsWith("image/")) {
        throw new HttpError(400, "Choose an image file", "INVALID_FILE_TYPE");
    }

    const user = await UserModel.findOne({ userId: request.auth.userId }) || new UserModel({ userId: request.auth.userId });
    const oldAvatarKey = user.avatarKey;

    const sanitizedUserId = request.auth.userId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const folder = `users/${sanitizedUserId}/avatar`;
    const ext = request.file.mimetype.split("/")[1] || "jpg";
    const filename = `avatar_${randomUUID()}.${ext}`;

    const file = await request.app.locals.storage.upload({
        buffer: request.file.buffer,
        mimeType: request.file.mimetype,
        folder,
        filename,
    });

    user.avatarUrl = file.url;
    user.avatarKey = file.key;
    await user.save();

    if (oldAvatarKey) {
        await cleanStorage(request, oldAvatarKey);
    }

    response.status(201).json({ data: user.toObject() });
});

// Delete user avatar
profileRouter.delete("/avatar", async (request, response) => {
    const user = await UserModel.findOne({ userId: request.auth.userId });
    if (!user) throw new HttpError(404, "User not found", "NOT_FOUND");

    if (user.avatarKey) {
        await cleanStorage(request, user.avatarKey);
    }
    user.avatarUrl = "";
    user.avatarKey = "";
    await user.save();

    response.json({ data: user.toObject() });
});

// Delete account: permanently remove user, relationships, messages, memories, jobs, and uploaded avatar
profileRouter.delete("/", async (request, response) => {
    const userId = request.auth?.userId;
    if (!userId) {
        throw new HttpError(401, "Unauthorized", "UNAUTHORIZED");
    }

    const user = await UserModel.findOne({ userId });

    // 1. Find all relationships for this user
    const relationships = await RelationshipModel.find({ userId }).select("_id").lean();
    const relIds = relationships.map((r) => r._id);

    // 2. Delete all messages for these relationships
    if (relIds.length > 0) {
        await MessageModel.deleteMany({ relationshipId: { $in: relIds } });
        await MemoryJobModel.deleteMany({ relationshipId: { $in: relIds } });
    }

    // 3. Delete all memories
    await MemoryModel.deleteMany({
        $or: [
            { userId },
            ...(relIds.length > 0 ? [{ relationshipId: { $in: relIds } }] : []),
        ],
    });

    // 4. Delete all relationships
    await RelationshipModel.deleteMany({ userId });
    await SwipeModel.deleteMany({ userId });

    // 5. Clean up user avatar in storage if present
    if (user?.avatarKey) {
        await cleanStorage(request, user.avatarKey);
    }

    // 6. Delete user profile record
    await UserModel.deleteOne({ userId });

    response.json({
        data: {
            success: true,
            message: "Account and all associated messages, memories, and data permanently deleted.",
        },
    });
});

const fcmTokenSchema = z.object({
    fcmToken: z.string().min(1).max(500),
    platform: z.enum(["ios", "android", "web"]).optional(),
    timezone: z.string().max(100).optional(),
});

profileRouter.post("/fcm-token", async (request, response) => {
    const body = fcmTokenSchema.parse(request.body);
    const update = {
        fcmToken: body.fcmToken,
        deviceInfoUpdatedAt: new Date(),
    };
    if (body.platform) update.platform = body.platform;
    if (body.timezone) update.timezone = body.timezone;

    await UserModel.findOneAndUpdate(
        { userId: request.auth.userId },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    response.json({ data: { success: true, message: "FCM token registered" } });
});
