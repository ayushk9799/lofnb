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
import { generateReply } from "../src/services/chat.service.js";
import { processProactiveCheckIns } from "../src/workers/proactive.worker.js";

const models = [CharacterModel, RelationshipModel, MessageModel, MemoryModel, MemoryJobModel];
const env = {
    NODE_ENV: "test",
    ALLOW_DEV_AUTH: true,
    CORS_ORIGIN: "http://localhost:5173",
    MEMORY_VECTOR_SEARCH_ENABLED: false,
};

let database, character, relationship, app, server, baseUrl;

const llm = {
    name: "fake",
    model: "fake",
    async *streamChat() { yield "hi"; },
    async generateText({ messages }) {
        const sys = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
        if (sys.includes("Left-On-Read")) return "Left me on read? 😂";
        return "hey";
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
        slug: "elena",
        name: "Elena",
        age: 28,
        timezone: "America/New_York",
        persona: { summary: "Painter" },
        backstory: { summary: "Studio in Brooklyn" },
    });
    relationship = await RelationshipModel.create({
        userId: "test-user",
        characterId: character._id,
        userLastReadSequence: 0,
        companionLastReadSequence: 0,
    });
});

afterEach(() => vi.restoreAllMocks());

it("POST /relationships/:id/read advances userLastReadSequence and marks messages read", async () => {
    // Create two assistant messages
    await MessageModel.create({
        relationshipId: relationship._id,
        sequenceNumber: 1,
        role: "assistant",
        content: "Hello there!",
        status: "completed",
    });
    await MessageModel.create({
        relationshipId: relationship._id,
        sequenceNumber: 2,
        role: "assistant",
        content: "How is your day?",
        status: "completed",
    });

    // Check GET / before reading: unreadCount should be 2
    const listRes1 = await fetch(`${baseUrl}/api/relationships`, {
        headers: { "x-user-id": "test-user" },
    });
    const listJson1 = await listRes1.json();
    expect(listJson1.data[0].unreadCount).toBe(2);

    // Call POST /read with sequenceNumber = 2
    const readRes = await fetch(`${baseUrl}/api/relationships/${relationship._id}/read`, {
        method: "POST",
        headers: {
            "x-user-id": "test-user",
            "content-type": "application/json",
        },
        body: JSON.stringify({ sequenceNumber: 2 }),
    });
    expect(readRes.status).toBe(200);
    const readJson = await readRes.json();
    expect(readJson.data.userLastReadSequence).toBe(2);
    expect(readJson.data.userLastReadAt).toBeDefined();

    // Check GET / after reading: unreadCount should be 0
    const listRes2 = await fetch(`${baseUrl}/api/relationships`, {
        headers: { "x-user-id": "test-user" },
    });
    const listJson2 = await listRes2.json();
    expect(listJson2.data[0].unreadCount).toBe(0);

    // Messages should now have readAt set
    const msgs = await MessageModel.find({ relationshipId: relationship._id }).sort({ sequenceNumber: 1 });
    expect(msgs[0].readAt).toBeDefined();
    expect(msgs[1].readAt).toBeDefined();
});

it("companion marks user message read and updates companionLastReadSequence on reply", async () => {
    const emitted = [];
    await generateReply({
        relationshipId: relationship._id,
        userId: "test-user",
        body: { content: "Hey Elena", clientMessageId: "cmsg-001" },
        env,
        llm: {
            name: "fake",
            model: "fake",
            async *streamChat() { yield "Hey back!"; },
            async generateText() { return "Hey back!"; },
        },
        signal: new AbortController().signal,
        emit: (event, data) => emitted.push({ event, data }),
    });

    const userMsg = await MessageModel.findOne({ relationshipId: relationship._id, role: "user" });
    expect(userMsg).toBeTruthy();
    expect(userMsg.readAt).toBeDefined();

    const updatedRel = await RelationshipModel.findById(relationship._id);
    expect(updatedRel.companionLastReadSequence).toBe(userMsg.sequenceNumber);
    expect(updatedRel.companionLastReadAt).toBeDefined();

    const seenEvent = emitted.find(e => e.event === "seen");
    expect(seenEvent).toBeDefined();
    expect(seenEvent.data.userSequence).toBe(userMsg.sequenceNumber);
});

it("proactive worker triggers left_on_read when user read the last assistant message", async () => {
    // Assistant message with sequence 1, and user already read sequence 1
    await MessageModel.create({
        relationshipId: relationship._id,
        sequenceNumber: 1,
        role: "assistant",
        content: "What are your plans tonight?",
        status: "completed",
    });
    await RelationshipModel.findByIdAndUpdate(relationship._id, {
        userLastReadSequence: 1,
        userLastReadAt: new Date(Date.now() - 70_000),
        nextSequence: 2,
        lastMessageAt: new Date(Date.now() - 3 * 60 * 1000),
    });
    await MessageModel.updateOne(
        { relationshipId: relationship._id, sequenceNumber: 1 },
        { $set: { createdAt: new Date(Date.now() - 3 * 60 * 1000) } },
    );

    let capturedPrompt = "";
    const testLlm = {
        name: "fake",
        model: "fake",
        async generateText({ messages }) {
            capturedPrompt = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
            return "Left me on read? 😂";
        },
    };

    await processProactiveCheckIns({
        llm: testLlm,
    });

    expect(capturedPrompt).toContain("Left-On-Read Directive");
    expect(capturedPrompt).toContain("hello??");
    expect(capturedPrompt).toContain("am i not enough");
    expect(capturedPrompt).toContain("Write a new sentence");
    expect(capturedPrompt).not.toContain("## Media");
});
