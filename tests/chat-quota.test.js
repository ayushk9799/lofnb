import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { UserModel } from "../src/models/user.model.js";
import { generateReply } from "../src/services/chat.service.js";
import {
    DEFAULT_FREE_MESSAGES_PER_COMPANION,
    getCompanionAvailability,
    resolveCompanionOfflineMinutes,
    resolveFreeMessageLimit,
} from "../src/services/chat-quota.service.js";
import { processProactiveCheckIns } from "../src/workers/proactive.worker.js";
import { HttpError } from "../src/utils/http-error.js";

const models = [CharacterModel, RelationshipModel, MessageModel, UserModel];
const env = {
    NODE_ENV: "test",
    ALLOW_DEV_AUTH: true,
    CORS_ORIGIN: "http://localhost:5173",
    MEMORY_VECTOR_SEARCH_ENABLED: false,
};

let database, character, relationship;
const llm = {
    name: "fake",
    model: "fake",
    async *streamChat() {
        yield "hello";
    },
    async generateText() {
        return "hey there";
    },
};

beforeAll(async () => {
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(database.getUri());
    await Promise.all(models.map((model) => model.init()));
});

afterAll(async () => {
    await mongoose.disconnect();
    await database?.stop();
});

beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
    character = await CharacterModel.create({
        slug: "robin",
        name: "Robin",
        age: 44,
        persona: { summary: "Architect" },
        backstory: { summary: "Lives in London" },
    });
    relationship = await RelationshipModel.create({
        userId: "alice",
        characterId: character._id,
    });
});

afterEach(() => {});

function reply(overrides = {}) {
    const { body, env: envOverride, ...rest } = overrides;
    return generateReply({
        relationshipId: relationship._id,
        userId: "alice",
        env: envOverride || env,
        llm,
        signal: new AbortController().signal,
        emit: () => {},
        ...rest,
        body: { content: "hello", clientMessageId: "request-001", clientGems: 99, ...body },
    });
}

async function seedUserMessages(count, { relationshipId = relationship._id, start = 1 } = {}) {
    if (count <= 0) return;
    await MessageModel.insertMany(
        Array.from({ length: count }, (_, index) => ({
            relationshipId,
            sequenceNumber: start + index,
            role: "user",
            content: `msg-${start + index}`,
            status: "completed",
            clientMessageId: `seed-${relationshipId}-${start + index}`,
        })),
    );
    await RelationshipModel.updateOne(
        { _id: relationshipId },
        { $max: { nextSequence: start + count - 1 } },
    );
}

it("defaults the free message cap to 10 when no backend value is set", () => {
    expect(resolveFreeMessageLimit(undefined)).toBe(DEFAULT_FREE_MESSAGES_PER_COMPANION);
    expect(resolveFreeMessageLimit({})).toBe(10);
    expect(resolveFreeMessageLimit({ FREE_MESSAGES_PER_COMPANION: "" })).toBe(10);
    expect(resolveFreeMessageLimit({ FREE_MESSAGES_PER_COMPANION: "nope" })).toBe(10);
    expect(resolveFreeMessageLimit({ FREE_MESSAGES_PER_COMPANION: 0 })).toBe(10);
    expect(resolveFreeMessageLimit({ FREE_MESSAGES_PER_COMPANION: 5 })).toBe(5);
    expect(resolveCompanionOfflineMinutes(undefined)).toBe(480);
    expect(resolveCompanionOfflineMinutes({ COMPANION_OFFLINE_MINUTES: 6 })).toBe(6);
    expect(resolveCompanionOfflineMinutes({ COMPANION_OFFLINE_HOURS: 8 })).toBe(480);
});

it("lets a free user send up to the cap, then takes the companion offline", async () => {
    await seedUserMessages(9);
    await reply({ body: { clientMessageId: "turn-10" } });
    expect(await MessageModel.countDocuments({ relationshipId: relationship._id, role: "user" })).toBe(10);

    await expect(reply({ body: { clientMessageId: "turn-11" } })).rejects.toMatchObject({
        status: 403,
        code: "COMPANION_OFFLINE",
    });
    expect(await MessageModel.countDocuments({ relationshipId: relationship._id, role: "user" })).toBe(10);
    const rel = await RelationshipModel.findById(relationship._id).lean();
    expect(rel.companionOfflineUntil.getTime()).toBeGreaterThan(Date.now() + 7 * 60 * 60 * 1000);
});

it("uses COMPANION_OFFLINE_MINUTES from the backend env for the wait", async () => {
    const tightEnv = { ...env, FREE_MESSAGES_PER_COMPANION: 5, COMPANION_OFFLINE_MINUTES: 6 };
    await seedUserMessages(4);
    const before = Date.now();
    await reply({ env: tightEnv, body: { clientMessageId: "turn-5" } });
    const rel = await RelationshipModel.findById(relationship._id).lean();
    expect(rel.companionOfflineUntil.getTime()).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
    expect(rel.companionOfflineUntil.getTime()).toBeLessThanOrEqual(Date.now() + 6 * 60 * 1000 + 2000);
    await expect(reply({ env: tightEnv, body: { clientMessageId: "turn-6" } })).rejects.toMatchObject({
        code: "COMPANION_OFFLINE",
    });
});

it("brings her back after the offline window and starts a new free 10", async () => {
    await seedUserMessages(10);
    await RelationshipModel.updateOne(
        { _id: relationship._id },
        { $set: { companionOfflineUntil: new Date(Date.now() - 1000) } },
    );
    await reply({ body: { clientMessageId: "after-wait" } });
    expect(await MessageModel.countDocuments({ relationshipId: relationship._id, role: "user" })).toBe(11);
    const rel = await RelationshipModel.findById(relationship._id).lean();
    expect(rel.companionOfflineUntil).toBeFalsy();
    expect(rel.freeMessageWindowStart).toBeTruthy();
});

it("counts only the new window after she comes back, then goes offline again at 10", async () => {
    await seedUserMessages(10);
    await RelationshipModel.updateOne(
        { _id: relationship._id },
        { $set: { companionOfflineUntil: new Date(Date.now() - 1000) } },
    );

    const afterReset = await getCompanionAvailability({
        userId: "alice",
        relationshipId: relationship._id,
        env,
    });
    expect(afterReset.companionOffline).toBe(false);
    expect(afterReset.userMessageCount).toBe(0);

    for (let i = 1; i <= 10; i++) {
        await reply({ body: { clientMessageId: `window2-${i}` } });
    }
    expect(await MessageModel.countDocuments({
        relationshipId: relationship._id,
        role: "user",
    })).toBe(20);

    const atCap = await getCompanionAvailability({
        userId: "alice",
        relationshipId: relationship._id,
        env,
    });
    expect(atCap.userMessageCount).toBe(10);
    expect(atCap.companionOffline).toBe(true);

    await expect(reply({ body: { clientMessageId: "window2-11" } })).rejects.toMatchObject({
        status: 403,
        code: "COMPANION_OFFLINE",
    });
    expect(await MessageModel.countDocuments({
        relationshipId: relationship._id,
        role: "user",
    })).toBe(20);
});

it("does not count companion replies toward the free cap", async () => {
    await seedUserMessages(9);
    await MessageModel.insertMany(
        Array.from({ length: 20 }, (_, index) => ({
            relationshipId: relationship._id,
            sequenceNumber: 100 + index,
            role: "assistant",
            content: "her reply",
            status: "completed",
        })),
    );
    await RelationshipModel.updateOne(
        { _id: relationship._id },
        { $max: { nextSequence: 119 } },
    );
    await reply({ body: { clientMessageId: "turn-10" } });
    expect(await MessageModel.countDocuments({ relationshipId: relationship._id, role: "user" })).toBe(10);
});

it("uses a custom FREE_MESSAGES_PER_COMPANION from the backend env", async () => {
    const tightEnv = { ...env, FREE_MESSAGES_PER_COMPANION: 2 };
    await seedUserMessages(2);
    await expect(reply({ env: tightEnv, body: { clientMessageId: "turn-3" } })).rejects.toBeInstanceOf(HttpError);
    await expect(reply({ env: tightEnv, body: { clientMessageId: "turn-3" } })).rejects.toMatchObject({
        code: "COMPANION_OFFLINE",
    });
});

it("does not spend hearts and still goes offline with zero gems", async () => {
    await seedUserMessages(10);
    await expect(reply({ body: { clientMessageId: "broke", clientGems: 0 } })).rejects.toMatchObject({
        code: "COMPANION_OFFLINE",
    });
    expect(await MessageModel.countDocuments({ relationshipId: relationship._id, role: "user" })).toBe(10);
});

it("lets Gold members keep chatting after the free cap", async () => {
    await UserModel.create({ userId: "alice", isPremium: true });
    await seedUserMessages(10);
    await reply({ body: { clientMessageId: "gold-11" } });
    expect(await MessageModel.countDocuments({ relationshipId: relationship._id, role: "user" })).toBe(11);
});

it("allows retrying an already-saved turn while the companion is offline", async () => {
    await seedUserMessages(9);
    await reply({ body: { clientMessageId: "turn-10", content: "last free hello" } });
    await reply({ body: { clientMessageId: "turn-10", content: "last free hello" } });
    expect(await MessageModel.countDocuments({ relationshipId: relationship._id, role: "user" })).toBe(10);
});

it("keeps a second companion online when another chat hits the cap", async () => {
    const other = await CharacterModel.create({
        slug: "maya",
        name: "Maya",
        age: 26,
        persona: { summary: "Photographer" },
        backstory: { summary: "Lives in Brooklyn" },
    });
    const otherRel = await RelationshipModel.create({
        userId: "alice",
        characterId: other._id,
    });
    await seedUserMessages(10);
    await generateReply({
        relationshipId: otherRel._id,
        userId: "alice",
        env,
        llm,
        signal: new AbortController().signal,
        emit: () => {},
        body: { content: "hey", clientMessageId: "other-1", clientGems: 0 },
    });
    expect(await MessageModel.countDocuments({ relationshipId: otherRel._id, role: "user" })).toBe(1);
});

it("marks the companion offline on the relationship list for free users at the cap", async () => {
    await seedUserMessages(10);
    const app = createApp({ env, llm });
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/relationships`, {
            headers: { "x-user-id": "alice" },
        });
        const json = await res.json();
        expect(json.data[0].companionOffline).toBe(true);
        expect(json.data[0].companionOfflineUntil).toBeTruthy();
        expect(json.data[0].freeMessageLimit).toBe(10);
        expect(json.data[0].companionOfflineMinutes).toBe(480);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

it("does not send proactive check-ins after she has gone offline", async () => {
    await seedUserMessages(10);
    await MessageModel.create({
        relationshipId: relationship._id,
        sequenceNumber: 11,
        role: "assistant",
        content: "see you later",
        status: "completed",
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    await RelationshipModel.updateOne(
        { _id: relationship._id },
        { $set: { lastMessageAt: new Date(Date.now() - 5 * 60 * 1000) } },
    );
    await processProactiveCheckIns({ llm, env, leftOnReadMs: 1, goneOfflineMs: 1, lateReplyMs: 1 });
    expect(await MessageModel.countDocuments({
        relationshipId: relationship._id,
        role: "assistant",
        origin: "initiated",
    })).toBe(0);
});
