import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { UserModel } from "../models/user.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { MemoryModel } from "../models/memory.model.js";
import { SwipeModel } from "../models/swipe.model.js";
import {
    createSessionToken,
    verifyAppleToken,
    verifyGoogleToken,
    verifySessionToken,
} from "../services/auth.service.js";
import { HttpError } from "../utils/http-error.js";

export const authRouter = Router();

function newAccountIdentity() {
    const accountId = randomUUID();
    return { accountId, revenueCatAppUserId: accountId };
}

async function ensureAccountIdentity(user) {
    let changed = false;
    if (!user.accountId) {
        user.accountId = randomUUID();
        changed = true;
    }
    if (!user.revenueCatAppUserId) {
        // Preserve the legacy provider-scoped RevenueCat ID for existing users so
        // their previously purchased entitlements remain attached.
        user.revenueCatAppUserId = user.userId;
        changed = true;
    }
    if (changed) await user.save();
    return user;
}

const googleAuthSchema = z.object({
    token: z.string().min(1).optional(),
    idToken: z.string().min(1).optional(),
    preferredLanguage: z.string().optional(),
}).refine(data => data.token || data.idToken, {
    message: "Google token is required (token or idToken)",
    path: ["token"],
});

const appleAuthSchema = z.object({
    idToken: z.string().min(1),
    displayName: z.string().optional(),
    email: z.string().optional(),
    preferredLanguage: z.string().optional(),
});

function sessionResponse(user, { isNewUser }) {
    const userData = user.toObject();
    const sessionToken = createSessionToken({ userId: user.userId, email: user.email });
    return {
        success: true,
        data: {
            user: userData,
            token: sessionToken,
            userId: user.userId,
            isNewUser: Boolean(isNewUser),
        },
        user: userData,
        token: sessionToken,
        isNewUser: Boolean(isNewUser),
    };
}

async function handleGoogleAuth(request, response) {
    const body = googleAuthSchema.parse(request.body);
    const token = body.token || body.idToken;
    const verified = await verifyGoogleToken(token);

    const userId = `google_${verified.sub}`;
    let user = await UserModel.findOne({ userId });
    let isNewUser = false;

    if (!user) {
        isNewUser = true;
        user = await UserModel.create({
            userId,
            ...newAccountIdentity(),
            email: verified.email,
            authProvider: "google",
            providerId: verified.sub,
            name: verified.name || "Companion User",
            avatarUrl: verified.avatarUrl || "",
            vibe: "Everyone",
            minAge: 18,
            maxAge: 60,
        });
    } else {
        // Update email or avatar if previously empty
        let updated = false;
        if (!user.email && verified.email) { user.email = verified.email; updated = true; }
        if (!user.avatarUrl && verified.avatarUrl) { user.avatarUrl = verified.avatarUrl; updated = true; }
        if (!user.name && verified.name) { user.name = verified.name; updated = true; }
        if (updated) await user.save();
    }

    await ensureAccountIdentity(user);
    response.json(sessionResponse(user, { isNewUser }));
}

async function handleAppleAuth(request, response) {
    const body = appleAuthSchema.parse(request.body);
    const verified = await verifyAppleToken(body.idToken, body.displayName, body.email);

    const userId = `apple_${verified.sub}`;
    let user = await UserModel.findOne({ userId });
    let isNewUser = false;

    if (!user) {
        isNewUser = true;
        user = await UserModel.create({
            userId,
            ...newAccountIdentity(),
            email: verified.email,
            authProvider: "apple",
            providerId: verified.sub,
            name: verified.name || "Companion User",
            avatarUrl: "",
            vibe: "Everyone",
            minAge: 18,
            maxAge: 60,
        });
    } else {
        let updated = false;
        if (!user.email && verified.email) { user.email = verified.email; updated = true; }
        if (!user.name && verified.name) { user.name = verified.name; updated = true; }
        if (updated) await user.save();
    }

    await ensureAccountIdentity(user);
    response.json(sessionResponse(user, { isNewUser }));
}

authRouter.post("/google", handleGoogleAuth);
authRouter.post("/google/loginSignUp", handleGoogleAuth);

authRouter.post("/apple", handleAppleAuth);
authRouter.post("/apple/loginSignUp", handleAppleAuth);

authRouter.get("/me", async (request, response) => {
    let userId = request.auth?.userId;
    if (!userId) {
        const authHeader = request.header("authorization")?.trim();
        if (authHeader && authHeader.startsWith("Bearer ")) {
            const payload = verifySessionToken(authHeader.slice(7).trim());
            userId = payload.userId;
        } else if (request.header("x-user-id")) {
            userId = request.header("x-user-id").trim();
        }
    }
    if (!userId) {
        throw new HttpError(401, "Not authenticated", "UNAUTHORIZED");
    }
    const user = await UserModel.findOne({ userId });
    if (!user) {
        throw new HttpError(404, "User not found", "NOT_FOUND");
    }
    await ensureAccountIdentity(user);
    response.json({ data: user.toObject() });
});

authRouter.all("/clean-mock-data", async (_request, response) => {
    const mockFilter = {
        $or: [
            { userId: { $regex: /^(google_dev_|apple_dev_|mock_|lofn-mobile-dev)/ } },
            { email: { $regex: /^(dev_|mock_)/ } },
            { name: { $regex: /^User dev_/ } },
        ]
    };
    const mockUsers = await UserModel.find(mockFilter).select("userId");
    const ids = mockUsers.map(u => u.userId);
    const [deletedUsers, deletedRel, deletedMsg, deletedMem, deletedSwipes] = await Promise.all([
        UserModel.deleteMany(mockFilter),
        RelationshipModel.deleteMany({ userId: { $in: ids } }),
        MessageModel.deleteMany({ userId: { $in: ids } }),
        MemoryModel.deleteMany({ userId: { $in: ids } }),
        SwipeModel.deleteMany({ userId: { $in: ids } }),
    ]);

    response.json({
        success: true,
        message: "Mock data purged successfully",
        deleted: {
            users: deletedUsers.deletedCount,
            relationships: deletedRel.deletedCount,
            messages: deletedMsg.deletedCount,
            memories: deletedMem.deletedCount,
            swipes: deletedSwipes.deletedCount,
        },
    });
});
