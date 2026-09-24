import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";

const models = [CharacterModel, RelationshipModel, MessageModel];
const env = {
    NODE_ENV: "test",
    ALLOW_DEV_AUTH: true,
    CORS_ORIGIN: "http://localhost:5173",
    MEMORY_VECTOR_SEARCH_ENABLED: false,
};

let database, relationship, server, baseUrl;

beforeAll(async () => {
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(database.getUri());
    await Promise.all(models.map(m => m.init()));
    const app = createApp({ env, llm: { name: "fake", model: "fake", async *streamChat() { yield "hi"; } } });
    server = createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect().catch(() => {});
    await database?.stop();
});

beforeEach(async () => {
    await Promise.all(models.map(m => m.deleteMany({})));
    const character = await CharacterModel.create({
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
    });
    await MessageModel.insertMany(
        Array.from({ length: 10 }, (_, i) => ({
            relationshipId: relationship._id,
            sequenceNumber: i + 1,
            role: i % 2 === 0 ? "assistant" : "user",
            content: `msg-${i + 1}`,
            status: "completed",
        })),
    );
});

function messagesUrl(query = "") {
    return `${baseUrl}/api/relationships/${relationship._id}/messages${query}`;
}

it("GET /messages?after=X returns contiguous ascending rows after X", async () => {
    const response = await fetch(messagesUrl("?after=5&limit=3"), {
        headers: { "x-user-id": "test-user" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map(m => m.sequenceNumber)).toEqual([6, 7, 8]);
});

it("GET /messages?before=Y returns chronological rows ending before Y", async () => {
    const response = await fetch(messagesUrl("?before=5&limit=3"), {
        headers: { "x-user-id": "test-user" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map(m => m.sequenceNumber)).toEqual([2, 3, 4]);
});

it("GET /messages default returns the newest batch in chronological order", async () => {
    const response = await fetch(messagesUrl("?limit=3"), {
        headers: { "x-user-id": "test-user" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map(m => m.sequenceNumber)).toEqual([8, 9, 10]);
});

it("GET /messages?after=&before= returns 400", async () => {
    const response = await fetch(messagesUrl("?after=5&before=8"), {
        headers: { "x-user-id": "test-user" },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
});

it("returns the same ordered bubbles when fetching history or incremental updates", async () => {
    const message = await MessageModel.findOne({relationshipId: relationship._id, sequenceNumber: 9});
    const bubbles = [{id: `${message._id}:0`, kind: "text", text: "hello"}, {id: `${message._id}:1`, kind: "text", text: "a second thought"}];
    message.content = "hello\n\na second thought";
    message.bubbles = bubbles;
    await message.save();
    for (const query of ["?after=8", "?before=10&limit=1"]) {
        const response = await fetch(messagesUrl(query), {headers: {"x-user-id": "test-user"}});
        const body = await response.json();
        expect(body.data[0].bubbles).toEqual(bubbles);
        expect(body.data[0].content).toBe(message.content);
    }
});
