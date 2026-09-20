import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { UserModel } from "../src/models/user.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { sendChatPushNotification, getUserUnreadMessageCount } from "../src/services/push-notification.service.js";

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
    await RelationshipModel.deleteMany({});
    await MessageModel.deleteMany({});
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

    it("getUserUnreadMessageCount only counts unread assistant messages and ignores new matches without messages", async () => {
        const dummyCharacterId1 = new mongoose.Types.ObjectId();
        const dummyCharacterId2 = new mongoose.Types.ObjectId();

        // 1. New match with 0 messages (uncelebrated/brand new)
        const _rel1 = await RelationshipModel.create({
            userId: testUserId,
            characterId: dummyCharacterId1,
            userLastReadSequence: 0,
        });

        // 2. Active relationship with 2 unread assistant messages, 1 user message, 1 read assistant message
        const rel2 = await RelationshipModel.create({
            userId: testUserId,
            characterId: dummyCharacterId2,
            userLastReadSequence: 1, // read up to sequence 1
        });

        await MessageModel.create([
            // read assistant message
            {
                relationshipId: rel2._id,
                sequenceNumber: 1,
                role: "assistant",
                content: "Hello",
                status: "completed",
            },
            // user message (should never count towards unread badge)
            {
                relationshipId: rel2._id,
                sequenceNumber: 2,
                role: "user",
                content: "Hi Elena",
                status: "completed",
            },
            // unread assistant message #1
            {
                relationshipId: rel2._id,
                sequenceNumber: 3,
                role: "assistant",
                content: "How is your day?",
                status: "completed",
            },
            // unread assistant message #2
            {
                relationshipId: rel2._id,
                sequenceNumber: 4,
                role: "assistant",
                content: "Thinking of you!",
                status: "completed",
            },
        ]);

        const unreadCount = await getUserUnreadMessageCount(testUserId);
        // rel1 has 0 unread messages (new match should NOT be counted)
        // rel2 has 2 unread assistant messages (seq 3 and 4)
        expect(unreadCount).toBe(2);

        // Once user reads rel2 up to sequence 4
        await RelationshipModel.updateOne(
            { _id: rel2._id },
            { $set: { userLastReadSequence: 4 } }
        );

        const updatedCount = await getUserUnreadMessageCount(testUserId);
        expect(updatedCount).toBe(0);
    });
});

