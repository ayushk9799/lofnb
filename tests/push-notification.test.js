import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { UserModel } from "../src/models/user.model.js";
import { sendChatPushNotification } from "../src/services/push-notification.service.js";

let database, app, server, baseUrl;
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
    server = app.listen(0);
    baseUrl = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
    server?.close();
    await mongoose.disconnect();
    await database?.stop();
});

beforeEach(async () => {
    await UserModel.deleteMany({});
});

describe("Push notification and FCM token management", () => {
    const testUserId = "test-user-fcm-123";

    it("handles sendChatPushNotification gracefully when firebase is not configured", async () => {
        const result = await sendChatPushNotification({
            userId: testUserId,
            characterName: "Elena",
            content: "Hey, are you there?",
            relationshipId: "rel-123",
        });
        expect(result).toBe(false);
    });

    it("registers and updates FCM token via /api/user/fcm-token", async () => {
        const res = await fetch(`${baseUrl}/api/user/fcm-token`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-user-id": testUserId,
            },
            body: JSON.stringify({
                fcmToken: "fcm_test_token_abc_123",
                platform: "ios",
                timezone: "America/New_York",
            }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.success).toBe(true);

        const user = await UserModel.findOne({ userId: testUserId });
        expect(user).toBeTruthy();
        expect(user.fcmToken).toBe("fcm_test_token_abc_123");
        expect(user.platform).toBe("ios");
        expect(user.timezone).toBe("America/New_York");
        expect(user.deviceInfoUpdatedAt).toBeInstanceOf(Date);
    });
});
