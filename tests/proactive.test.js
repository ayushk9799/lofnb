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
import {
    classifyProactiveTrigger,
    processProactiveCheckIns,
} from "../src/workers/proactive.worker.js";

const models = [CharacterModel, RelationshipModel, MessageModel, MemoryModel, MemoryJobModel];
const env = {NODE_ENV: "test", ALLOW_DEV_AUTH: true, CORS_ORIGIN: "http://localhost:5173", MEMORY_VECTOR_SEARCH_ENABLED: false};
let database, character, relationship, app, server, baseUrl;

const llm = {
    name: "fake",
    model: "fake",
    async *streamChat() { yield "hello"; },
    async generateText({ messages }) {
        const lastMsg = messages[messages.length - 1]?.content || "";
        const systems = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
        if (systems.includes("Double-Text Directive") || lastMsg.includes("Double-Text Directive")) return "and one more thing";
        if (systems.includes("Idle Nudge Directive") || lastMsg.includes("Idle Nudge Directive")) return "you just disappeared on me";
        if (systems.includes("Left-On-Read Directive")) return "you opened that and said nothing";
        if (systems.includes("Late Reply Directive")) return "wait, what were you saying";
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
        lastMessageAt: new Date(Date.now() - 4 * 60 * 1000),
    });
});

afterEach(() => vi.restoreAllMocks());

function systemText(messages) {
    return messages.filter(m => m.role === "system").map(m => m.content).join("\n");
}

async function lastTurn({ role, origin = "reply", content = "hey", seq = 1, agoMs, readAgoMs }) {
    const createdAt = new Date(Date.now() - agoMs);
    await MessageModel.create({
        relationshipId: relationship._id,
        sequenceNumber: seq,
        role,
        origin,
        content,
        status: "completed",
        createdAt,
        updatedAt: createdAt,
    });
    const update = { lastMessageAt: createdAt, nextSequence: seq + 1 };
    if (readAgoMs != null) {
        update.userLastReadSequence = seq;
        update.userLastReadAt = new Date(Date.now() - readAgoMs);
    }
    await RelationshipModel.updateOne({ _id: relationship._id }, { $set: update });
}

it("classifies left on read from the read clock, unread as gone offline, user as late reply", () => {
    const now = Date.now();
    const assistant = { role: "assistant", origin: "reply", sequenceNumber: 1, createdAt: new Date(now - 10 * 60_000) };
    expect(classifyProactiveTrigger(
        { userLastReadSequence: 1, userLastReadAt: new Date(now - 70_000) },
        assistant,
        now,
    )).toBe("left_on_read");
    expect(classifyProactiveTrigger(
        { userLastReadSequence: 1, userLastReadAt: new Date(now - 10_000) },
        assistant,
        now,
    )).toBeNull();
    expect(classifyProactiveTrigger({ userLastReadSequence: 0 }, assistant, now)).toBe("idle_nudge");
    expect(classifyProactiveTrigger(
        { userLastReadSequence: 0 },
        { ...assistant, createdAt: new Date(now - 60_000) },
        now,
    )).toBeNull();
    expect(classifyProactiveTrigger({}, { role: "user", createdAt: new Date(now - 90_000) }, now)).toBe("check_in");
    expect(classifyProactiveTrigger({}, { role: "assistant", origin: "initiated", sequenceNumber: 2, createdAt: new Date(now - 10 * 60_000) }, now)).toBeNull();
});

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
    expect(body2.data.content).toBe("you just disappeared on me");
});

it("puts the poke as a trailing directive with examples, and omits media tools", async () => {
    let captured = [];
    const testLlm = {
        name: "test",
        model: "test",
        async generateText({ messages }) {
            captured = messages;
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
        expect(captured[0].role).toBe("system");
        expect(captured[0].content).not.toContain("## Media");
        expect(captured[0].content).not.toContain("send_photo");
        const trailing = captured[captured.length - 1];
        expect(trailing.role).toBe("system");
        expect(trailing.content).toContain("Idle Nudge Directive");
        expect(trailing.content).toContain("hello??");
        expect(trailing.content).toContain("am i not enough");
        expect(trailing.content).toContain("Write a new sentence");
        expect(trailing.content).toContain("Do not paste those examples");
        expect(trailing.content).not.toContain("cold-blooded");
        expect(trailing.content).not.toContain("did your phone die");
    } finally {
        await new Promise(resolve => captureServer.close(resolve));
    }
});

it("skips proactive check-ins if the last message was already an unreplied initiated message", async () => {
    await lastTurn({
        role: "assistant",
        origin: "initiated",
        content: "previous unreplied text",
        agoMs: 10 * 60_000,
    });

    await processProactiveCheckIns({ llm });

    const messages = await MessageModel.find({ relationshipId: relationship._id });
    expect(messages).toHaveLength(1);
    const updatedRel = await RelationshipModel.findById(relationship._id);
    expect(updatedRel.lastInitiatedAt).toBeUndefined();
});

it("sends a late reply when stale and last message was from user", async () => {
    await lastTurn({ role: "user", content: "see ya later", agoMs: 2 * 60_000 });

    await processProactiveCheckIns({ llm });

    const messages = await MessageModel.find({ relationshipId: relationship._id }).sort({ sequenceNumber: 1 });
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].origin).toBe("initiated");
    expect(messages[1].content).toBe("wait, what were you saying");

    const updatedRel = await RelationshipModel.findById(relationship._id);
    expect(updatedRel.lastInitiatedAt).toBeDefined();
});

it("pokes at night when they went quiet", async () => {
    await lastTurn({ role: "user", content: "see ya later", agoMs: 2 * 60_000 });

    await processProactiveCheckIns({ llm });

    const messages = await MessageModel.find({ relationshipId: relationship._id });
    expect(messages).toHaveLength(2);
});

it("pokes left on read about a minute after they open it", async () => {
    await lastTurn({
        role: "assistant",
        content: "same. aggressively unproductive, basically.",
        agoMs: 10 * 60_000,
        readAgoMs: 70_000,
    });

    let captured = [];
    const testLlm = {
        name: "fake",
        model: "fake",
        async generateText({ messages }) {
            captured = messages;
            return "you opened that and said nothing. we matched for this?";
        },
    };

    await processProactiveCheckIns({ llm: testLlm });

    const trailing = captured[captured.length - 1];
    expect(trailing.content).toContain("Left-On-Read Directive");
    expect(trailing.content).toContain("hello??");
    expect(trailing.content).toContain("am i not enough");
    expect(trailing.content).toContain("we matched for this?");
    expect(trailing.content).toContain("Write a new sentence");
    expect(captured[0].content).not.toContain("## Media");
    const messages = await MessageModel.find({ relationshipId: relationship._id }).sort({ sequenceNumber: 1 });
    expect(messages.at(-1).content).toContain("we matched for this?");
});

it("treats an unread last assistant bubble as gone offline, not left on read", async () => {
    await lastTurn({
        role: "assistant",
        content: "same. aggressively unproductive, basically.",
        agoMs: 3 * 60_000,
    });

    let captured = [];
    const testLlm = {
        name: "fake",
        model: "fake",
        async generateText({ messages }) {
            captured = messages;
            return "you just disappeared";
        },
    };

    await processProactiveCheckIns({ llm: testLlm });
    expect(systemText(captured)).toContain("Idle Nudge Directive");
    expect(systemText(captured)).not.toContain("Left-On-Read Directive");
});

it("does not wait six hours to poke again after they reply", async () => {
    await lastTurn({ role: "user", content: "back", agoMs: 2 * 60_000 });
    await RelationshipModel.updateOne(
        { _id: relationship._id },
        { $set: { lastInitiatedAt: new Date(Date.now() - 60_000) } },
    );

    await processProactiveCheckIns({ llm });
    expect(await MessageModel.countDocuments({ relationshipId: relationship._id })).toBe(2);
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
