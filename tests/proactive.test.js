import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { MemoryModel } from "../src/models/memory.model.js";
import { MemoryJobModel } from "../src/models/memory-job.model.js";
import { processProactiveCheckIns } from "../src/workers/proactive.worker.js";

const models = [CharacterModel, RelationshipModel, MessageModel, MemoryModel, MemoryJobModel];
const env = {NODE_ENV: "test", ALLOW_DEV_AUTH: true, CORS_ORIGIN: "http://localhost:5173", MEMORY_VECTOR_SEARCH_ENABLED: false};
let database, character, relationship, app, server, baseUrl;

const llm = {
    name: "fake",
    model: "fake",
    async *streamChat() { yield "hello"; },
    async generateText({ messages }) {
        const lastMsg = messages[messages.length - 1]?.content || "";
        const systemPrompt = messages[0]?.content || "";
        if (systemPrompt.includes("Double-Text Directive") || lastMsg.includes("Double-Text Directive")) return "and one more thing";
        if (systemPrompt.includes("Idle Nudge Directive") || lastMsg.includes("Idle Nudge Directive")) return "you alive?";
        return "just saw a cool view in brooklyn";
    },
};

beforeAll(async () => {
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(database.getUri());
    await Promise.all(models.map(m => m.init()));
    app = createApp({ env, llm });
    server = createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    await database?.stop();
});

beforeEach(async () => {
    await Promise.all(models.map(m => m.deleteMany({})));
    character = await CharacterModel.create({
        slug: "maya",
        name: "Maya",
        age: 26,
        timezone: "America/New_York",
        persona: { summary: "Street photographer" },
        backstory: { summary: "Lives in Brooklyn" },
    });
    relationship = await RelationshipModel.create({
        userId: "dev_user",
        characterId: character._id,
        nextSequence: 2,
        lastMessageAt: new Date(Date.now() - 4 * 3600 * 1000), // 4 hours ago
    });
});

afterEach(() => vi.restoreAllMocks());

it("initiates via HTTP endpoint with triggerType follow_up and idle_nudge", async () => {
    const res1 = await fetch(`${baseUrl}/api/relationships/${relationship._id}/chat/initiate`, {
        method: "POST",
        headers: { "x-user-id": "dev_user", "content-type": "application/json" },
        body: JSON.stringify({ triggerType: "follow_up" }),
    });
    const body1 = await res1.json();

    expect(res1.status).toBe(201);
    expect(body1.data.role).toBe("assistant");
    expect(body1.data.origin).toBe("initiated");
    expect(body1.data.content).toBe("and one more thing");

    const res2 = await fetch(`${baseUrl}/api/relationships/${relationship._id}/chat/initiate`, {
        method: "POST",
        headers: { "x-user-id": "dev_user", "content-type": "application/json" },
        body: JSON.stringify({ triggerType: "idle_nudge" }),
    });
    const body2 = await res2.json();

    expect(res2.status).toBe(201);
    expect(body2.data.content).toBe("you alive?");
});

it("injects tone and expectancy awareness into idle_nudge directive", async () => {
    let capturedSystemPrompt = "";
    const testLlm = {
        name: "test",
        model: "test",
        async generateText({ messages }) {
            capturedSystemPrompt = messages[0]?.content || "";
            return "test reply";
        },
    };
    const appWithCapture = createApp({ env, llm: testLlm });
    const captureServer = createServer(appWithCapture);
    await new Promise(resolve => captureServer.listen(0, resolve));
    const port = captureServer.address().port;
    try {
        await fetch(`http://127.0.0.1:${port}/api/relationships/${relationship._id}/chat/initiate`, {
            method: "POST",
            headers: { "x-user-id": "dev_user", "content-type": "application/json" },
            body: JSON.stringify({ triggerType: "idle_nudge" }),
        });
        expect(capturedSystemPrompt).toContain("Inspect the tone and intent of your last message");
        expect(capturedSystemPrompt).toContain("expectant or inquisitive tone");
        expect(capturedSystemPrompt).toContain("without a question mark");
        expect(capturedSystemPrompt).toContain("leaving me on read");
    } finally {
        await new Promise(resolve => captureServer.close(resolve));
    }
});

it("skips proactive check-ins if the last message was already an unreplied initiated message", async () => {
    await MessageModel.create({
        relationshipId: relationship._id,
        sequenceNumber: 1,
        role: "assistant",
        origin: "initiated",
        content: "previous unreplied text",
        status: "completed",
    });

    await processProactiveCheckIns({
        llm,
        offlineThresholdMs: 3600 * 1000,
        cooldownMs: 3600 * 1000,
    });

    const messages = await MessageModel.find({ relationshipId: relationship._id });
    expect(messages).toHaveLength(1);
    const updatedRel = await RelationshipModel.findById(relationship._id);
    expect(updatedRel.lastInitiatedAt).toBeUndefined();
});

it("triggers proactive check-in when stale and last message was from user", async () => {
    await MessageModel.create({
        relationshipId: relationship._id,
        sequenceNumber: 1,
        role: "user",
        content: "see ya later",
        status: "completed",
    });

    // Mock Character's timezone to UTC during midday hour 14:00 (daytime)
    await CharacterModel.updateOne({ _id: character._id }, { timezone: "UTC" });
    const realDateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation((locale, options) => {
        if (options?.hour) {
            return {
                format: () => "14",
            };
        }
        return new realDateTimeFormat(locale, options);
    });

    await processProactiveCheckIns({
        llm,
        offlineThresholdMs: 3600 * 1000,
        cooldownMs: 3600 * 1000,
    });

    const messages = await MessageModel.find({ relationshipId: relationship._id });
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].origin).toBe("initiated");
    expect(messages[1].content).toBe("just saw a cool view in brooklyn");

    const updatedRel = await RelationshipModel.findById(relationship._id);
    expect(updatedRel.lastInitiatedAt).toBeDefined();
});

it("skips proactive check-in when it is nighttime in character timezone", async () => {
    await MessageModel.create({
        relationshipId: relationship._id,
        sequenceNumber: 1,
        role: "user",
        content: "see ya later",
        status: "completed",
    });

    // Mock 3 AM local time (nighttime)
    const realDateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation((locale, options) => {
        if (options?.hour) {
            return {
                format: () => "03",
            };
        }
        return new realDateTimeFormat(locale, options);
    });

    await processProactiveCheckIns({
        llm,
        offlineThresholdMs: 3600 * 1000,
        cooldownMs: 3600 * 1000,
    });

    const messages = await MessageModel.find({ relationshipId: relationship._id });
    expect(messages).toHaveLength(1);
});

it("skips timed apologies after tone feedback without generating another message", async () => {
    await MessageModel.create({relationshipId: relationship._id, sequenceNumber: 1, role: "user", content: "why are you so linkedin type emssages", status: "completed"});
    await MessageModel.create({relationshipId: relationship._id, sequenceNumber: 2, role: "assistant", content: "fair. that was stiff", status: "completed"});
    const generation = vi.spyOn(llm, "generateText");
    for (const triggerType of ["follow_up", "idle_nudge"]) {
        const response = await fetch(`${baseUrl}/api/relationships/${relationship._id}/chat/initiate`, {
            method: "POST", headers: {"x-user-id": "dev_user", "content-type": "application/json"}, body: JSON.stringify({triggerType}),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({data: null, skipped: true});
    }
    expect(generation).not.toHaveBeenCalled();
    expect(await MessageModel.countDocuments({relationshipId: relationship._id})).toBe(2);
});
