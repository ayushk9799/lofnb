import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { UserModel } from "../src/models/user.model.js";

let database, app;
const env = {
    NODE_ENV: "test",
    ALLOW_DEV_AUTH: true,
    CORS_ORIGIN: "http://localhost:5173",
    MEMORY_VECTOR_SEARCH_ENABLED: false,
};

beforeAll(async () => {
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(database.getUri());
    await UserModel.init();
    app = createApp({ env, llm: {}, embeddingProvider: {} });
});

afterAll(async () => {
    await mongoose.disconnect();
    await database?.stop();
});

beforeEach(async () => {
    await UserModel.deleteMany({});
});

describe("Google & Apple Auth Endpoints", () => {
    it("handles Google sign-in and upserts user", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/api/auth/google`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: "mock_google_12345" }),
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(body.data.userId).toBe("google_12345");
            expect(body.data.token).toBeUndefined();
            expect(body.token).toBeUndefined();
            expect(body.data.user.email).toBe("12345@gmail.com");
            expect(body.data.user.accountId).toBeTypeOf("string");
            expect(body.data.user.revenueCatAppUserId).toBe(body.data.user.accountId);
            expect(body.data.isNewUser).toBe(true);
            expect(body.data.user.onboardedAt).toBeFalsy();

            const saved = await UserModel.findOne({ userId: "google_12345" });
            expect(saved).not.toBeNull();
            expect(saved.authProvider).toBe("google");
            expect(saved.onboardedAt).toBeFalsy();

            const again = await fetch(`http://localhost:${port}/api/auth/google`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: "mock_google_12345" }),
            });
            const againBody = await again.json();
            expect(again.status).toBe(200);
            expect(againBody.data.isNewUser).toBe(false);
        } finally {
            server.close();
        }
    });

    it("handles Apple sign-in and upserts user", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/api/auth/apple`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    idToken: "mock_apple_98765",
                    displayName: "Apple Tester",
                    email: "apple.tester@privaterelay.appleid.com",
                }),
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
            expect(body.data.userId).toBe("apple_98765");
            expect(body.data.user.name).toBe("Apple Tester");
            expect(body.data.user.email).toBe("apple.tester@privaterelay.appleid.com");
            expect(body.data.user.accountId).toBeTypeOf("string");
            expect(body.data.user.revenueCatAppUserId).toBe(body.data.user.accountId);
            expect(body.data.isNewUser).toBe(true);

            const saved = await UserModel.findOne({ userId: "apple_98765" });
            expect(saved).not.toBeNull();
            expect(saved.authProvider).toBe("apple");
        } finally {
            server.close();
        }
    });

    it("rejects an unsigned forged Apple identity token", async () => {
        const encoded = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const forgedToken = `${encoded({ alg: "none", typ: "JWT" })}.${encoded({
            sub: "victim-apple-subject",
            iss: "https://appleid.apple.com",
            aud: "com.thousandways.lofn",
            exp: Math.floor(Date.now() / 1000) + 3600,
        })}.forged`;

        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/api/auth/apple`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ idToken: forgedToken }),
            });
            expect(res.status).toBe(401);
            expect(await UserModel.findOne({ userId: "apple_victim-apple-subject" })).toBeNull();
        } finally {
            server.close();
        }
    });

    it("keeps Google and Apple identities separate even when email matches", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const googleRes = await fetch(`http://localhost:${port}/api/auth/google`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: "mock_google_shared" }),
            });
            const googleBody = await googleRes.json();

            const appleRes = await fetch(`http://localhost:${port}/api/auth/apple`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    idToken: "mock_apple_different-provider",
                    email: "shared@gmail.com",
                }),
            });
            const appleBody = await appleRes.json();

            expect(googleRes.status).toBe(200);
            expect(appleRes.status).toBe(200);
            expect(googleBody.data.user.userId).not.toBe(appleBody.data.user.userId);
            expect(googleBody.data.user.accountId).not.toBe(appleBody.data.user.accountId);
            expect(await UserModel.countDocuments({ email: "shared@gmail.com" })).toBe(2);
        } finally {
            server.close();
        }
    });

    it("loads the saved account using its user ID", async () => {
        const user = await UserModel.create({
            userId: "bearer_user_1",
            name: "Bearer User",
            email: "bearer@example.com",
            authProvider: "google",
        });

        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/api/auth/me`, {
                headers: { "x-user-id": user.userId, Authorization: "Bearer expired-legacy-token" },
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.data.userId).toBe("bearer_user_1");
            expect(body.data.name).toBe("Bearer User");
        } finally {
            server.close();
        }
    });
});


it("uses existing user IDs in production and rejects missing or unknown IDs", async () => {
    await UserModel.create({userId: "id-only-user", name: "ID User"});
    const productionApp = createApp({env: {...env, NODE_ENV: "production", ALLOW_DEV_AUTH: false}, llm: {}, embeddingProvider: {}});
    const server = productionApp.listen(0);
    const base = `http://localhost:${server.address().port}`;
    try {
        const accepted = await fetch(`${base}/api/profile`, {headers: {"x-user-id": "id-only-user", Authorization: "Bearer expired-legacy-token"}});
        expect(accepted.status).toBe(200);
        expect((await accepted.json()).data.userId).toBe("id-only-user");
        expect((await fetch(`${base}/api/profile`)).status).toBe(401);
        expect((await fetch(`${base}/api/profile`, {headers: {"x-user-id": "unknown-user"}})).status).toBe(404);
    } finally { server.close(); }
});

it.each([
    ['google', 'ios'],
    ['google', 'android'],
    ['apple', 'ios'],
])('records %s sign-in platform %s independently of notifications', async (provider, platform) => {
    const server = app.listen(0);
    const url = `http://localhost:${server.address().port}/api/auth/${provider}`;
    const identity = provider === 'google' ? {token: 'mock_google_platform'} : {idToken: 'mock_apple_platform'};
    try {
        const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...identity, platform})});
        expect(response.status).toBe(200);
        const data = (await response.json()).data;
        expect(data.user.platform).toBe(platform);
        const saved = await UserModel.findOne({userId: data.userId}).lean();
        expect(saved.platform).toBe(platform);
        expect(saved.fcmToken).toBe('');
        expect(saved.deviceInfoUpdatedAt).toBeUndefined();
        // Old clients omitting platform must not erase the saved classification.
        const legacy = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(identity)});
        expect((await legacy.json()).data.user.platform).toBe(platform);
        // Older FCM clients cannot overwrite the sign-in platform.
        const push = await fetch(`http://localhost:${server.address().port}/api/profile/fcm-token`, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-user-id': data.userId}, body: JSON.stringify({fcmToken: 'new-fcm-token', platform: 'web'})});
        expect(push.status).toBe(200);
        expect((await UserModel.findOne({userId: data.userId})).platform).toBe(platform);
    } finally { server.close(); }
});

it('updates an existing Google account from iOS to Android at its next sign-in', async () => {
    await UserModel.create({userId: 'google_switch-device', platform: 'ios', name: 'Existing'});
    const server = app.listen(0);
    try {
        const response = await fetch(`http://localhost:${server.address().port}/api/auth/google`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: 'mock_google_switch-device', platform: 'android'})});
        const data = (await response.json()).data;
        expect(data.isNewUser).toBe(false);
        expect(data.user.platform).toBe('android');
        expect(await UserModel.countDocuments({userId: 'google_switch-device'})).toBe(1);
    } finally { server.close(); }
});

it.each(['google', 'apple'])('rejects invalid platform during %s sign-in', async provider => {
    const server = app.listen(0);
    try {
        const response = await fetch(`http://localhost:${server.address().port}/api/auth/${provider}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: 'mock_google_platform', idToken: 'mock_apple_platform', platform: 'google'})});
        expect(response.status).toBe(400);
        expect(await UserModel.countDocuments()).toBe(0);
    } finally { server.close(); }
});
