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
import { UserModel } from "../src/models/user.model.js";
import {
    classifyProactiveTrigger,
    processProactiveCheckIns,
} from "../src/workers/proactive.worker.js";

const models = [CharacterModel, RelationshipModel, MessageModel, MemoryModel, MemoryJobModel, UserModel];
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

it("does not treat a read receipt or thirty-second silence as a reason to message", () => {
    const now = Date.now();
    const assistant = {role: "assistant", origin: "reply", sequenceNumber: 1, createdAt: new Date(now - 30_000)};
    expect(classifyProactiveTrigger({userLastReadSequence: 1, userLastReadAt: new Date(now - 20_000)}, assistant, now)).toBeNull();
    expect(classifyProactiveTrigger({}, assistant, now)).toBeNull();
    expect(classifyProactiveTrigger({}, {...assistant, role: "user", content: "what were you making?", createdAt: new Date(now - 100_000)}, now)).toBe("check_in");
    expect(classifyProactiveTrigger({}, {...assistant, role: "user", content: "goodnight", createdAt: new Date(now - 100_000)}, now)).toBeNull();
    expect(classifyProactiveTrigger({}, {...assistant, status: "streaming"}, now)).toBeNull();
});

it("requires a relevant thread and a long cooldown for callbacks", () => {
    const now = Date.now();
    const assistant = {role: "assistant", origin: "reply", createdAt: new Date(now - 7 * 60 * 60_000)};
    expect(classifyProactiveTrigger({}, assistant, now)).toBeNull();
    const relationship = {conversationState: {activeThread: "shared film recommendations"}};
    expect(classifyProactiveTrigger(relationship, assistant, now)).toBe("callback");
    expect(classifyProactiveTrigger({...relationship, lastInitiatedAt: new Date(now - 60_000)}, assistant, now)).toBeNull();
});

it("ignores legacy client timers without generating extra bubbles", async () => {
    const generation = vi.spyOn(llm, "generateText");
    for (const triggerType of ["follow_up", "idle_nudge"]) {
        const response = await fetch(`${baseUrl}/api/relationships/${relationship._id}/chat/initiate`, {
            method: "POST", headers: {"x-user-id": "dev_user", "content-type": "application/json"}, body: JSON.stringify({triggerType}),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({data: null, skipped: true});
    }
    expect(generation).not.toHaveBeenCalled();
    expect(await MessageModel.countDocuments()).toBe(0);
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
    await lastTurn({ role: "user", content: "what were you saying?", agoMs: 2 * 60_000 });

    await processProactiveCheckIns({ llm });

    const messages = await MessageModel.find({ relationshipId: relationship._id }).sort({ sequenceNumber: 1 });
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].origin).toBe("initiated");
    expect(messages[1].content).toBe("wait, what were you saying");

    const updatedRel = await RelationshipModel.findById(relationship._id);
    expect(updatedRel.lastInitiatedAt).toBeDefined();
});

it("does not initiate after a user goodbye or before idle threshold", async () => {
    await lastTurn({role: "user", content: "goodnight", agoMs: 2 * 60_000});
    const generation = vi.spyOn(llm, "generateText");
    await processProactiveCheckIns({llm});
    expect(generation).not.toHaveBeenCalled();
    await MessageModel.deleteMany({});
    await lastTurn({role: "assistant", content: "enjoy your evening", agoMs: 30_000, readAgoMs: 10_000});
    await processProactiveCheckIns({llm});
    expect(generation).not.toHaveBeenCalled();
});

it("answers an actual new user message independently of callback cooldown", async () => {
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

it("triggers idle_nudge after 1 minute of inactivity when user did not reply", async () => {
    await lastTurn({ role: "assistant", content: "what are you working on today?", agoMs: 70_000 });

    let capturedMessages = [];
    const captureLlm = {
        name: "fake",
        model: "fake",
        async generateText({ messages }) {
            capturedMessages = messages;
            return "got busy?";
        },
    };

    await processProactiveCheckIns({ llm: captureLlm });

    const messages = await MessageModel.find({ relationshipId: relationship._id }).sort({ sequenceNumber: 1 });
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].origin).toBe("initiated");
    expect(messages[1].content).toBe("got busy?");

    const systemPrompt = capturedMessages.map(m => m.content).join("\n");
    expect(systemPrompt).toContain("Idle Nudge Directive");
    expect(systemPrompt).toContain("Relationship Stage: 'new'");
    expect(systemPrompt).toContain("DO NOT USE CANNED TEMPLATES");
});

it("injects stage-calibrated guidance and pending question into the directive", async () => {
    await RelationshipModel.updateOne(
        { _id: relationship._id },
        { 
            $set: { 
                stage: "friends",
                "conversationState.pendingQuestion": "do you play any games?"
            } 
        }
    );
    await lastTurn({ role: "assistant", content: "do you play any games?", agoMs: 70_000 });

    let capturedMessages = [];
    const captureLlm = {
        name: "fake",
        model: "fake",
        async generateText({ messages }) {
            capturedMessages = messages;
            return "did you get sucked into work?";
        },
    };

    await processProactiveCheckIns({ llm: captureLlm });

    const systemPrompt = capturedMessages.map(m => m.content).join("\n");
    expect(systemPrompt).toContain("Relationship Stage: 'friends'");
    expect(systemPrompt).toContain("do you play any games?");
    expect(systemPrompt).toContain("Playful peer dynamic");
});

it("allows idle_nudge during nighttime hours without quiet hours suppression", async () => {
    await lastTurn({ role: "assistant", content: "what are you up to?", agoMs: 70_000 });

    const generation = vi.spyOn(llm, "generateText");
    await processProactiveCheckIns({ llm });
    expect(generation).toHaveBeenCalled();
    expect(await MessageModel.countDocuments({ relationshipId: relationship._id })).toBe(2);
});

it("does not initiate idle_nudge before the 1-minute threshold", async () => {
    await lastTurn({ role: "assistant", content: "what are you up to?", agoMs: 30_000 });

    const generation = vi.spyOn(llm, "generateText");
    await processProactiveCheckIns({ llm });
    expect(generation).not.toHaveBeenCalled();
    expect(await MessageModel.countDocuments({ relationshipId: relationship._id })).toBe(1);
});
