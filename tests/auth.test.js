import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { UserModel } from "../src/models/user.model.js";
import { createSessionToken, verifySessionToken } from "../src/services/auth.service.js";

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

describe("Auth & Session Service", () => {
    it("creates and verifies signed session tokens", () => {
        const token = createSessionToken({ userId: "test-user-123", email: "test@example.com" });
        expect(token).toBeTypeOf("string");
        const payload = verifySessionToken(token);
        expect(payload.userId).toBe("test-user-123");
        expect(payload.email).toBe("test@example.com");
    });

    it("rejects tampered session tokens", () => {
        const token = createSessionToken({ userId: "test-user-123" });
        const tampered = token.slice(0, -5) + "abcde";
        expect(() => verifySessionToken(tampered)).toThrow();
    });
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
            expect(body.data.token).toBeTypeOf("string");
            expect(body.data.user.email).toBe("12345@gmail.com");

            const saved = await UserModel.findOne({ userId: "google_12345" });
            expect(saved).not.toBeNull();
            expect(saved.authProvider).toBe("google");
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

            const saved = await UserModel.findOne({ userId: "apple_98765" });
            expect(saved).not.toBeNull();
            expect(saved.authProvider).toBe("apple");
        } finally {
            server.close();
        }
    });

    it("authenticates requests with Bearer token", async () => {
        const user = await UserModel.create({
            userId: "bearer_user_1",
            name: "Bearer User",
            email: "bearer@example.com",
            authProvider: "google",
        });
        const token = createSessionToken({ userId: user.userId, email: user.email });

        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/api/auth/me`, {
                headers: { Authorization: `Bearer ${token}` },
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
