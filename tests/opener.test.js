import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { SwipeModel } from "../src/models/swipe.model.js";
import { UserModel } from "../src/models/user.model.js";
import { processDueOpeners } from "../src/workers/opener.worker.js";
import { OPENER_MAX_PENDING, OPENER_MIN_DELAY_MS, OPENER_MAX_DELAY_MS } from "../src/routes/swipes.routes.js";

const models = [CharacterModel, RelationshipModel, MessageModel, SwipeModel, UserModel];
const env = { NODE_ENV: "test", ALLOW_DEV_AUTH: true, CORS_ORIGIN: "http://localhost:5173", MEMORY_VECTOR_SEARCH_ENABLED: false, MATCH_RATE: 1 };

const llm = {
    name: "fake",
    model: "fake",
    async *streamChat() { yield "hello"; },
    async generateText({ messages }) {
        const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
        expect(system).toContain("Opener Directive");
        expect(messages.some(m => m.role === "user")).toBe(false);
        return "hey";
    },
};

let database, server, baseUrl;

beforeAll(async () => {
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(database.getUri());
    await Promise.all(models.map(m => m.init()));
    server = createServer(createApp({ env, llm }));
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
});

async function createCharacters(count) {
    return CharacterModel.create(
        Array.from({ length: count }, (_, i) => ({
            slug: `c-${i}`, name: `Char ${i}`, age: 25, matchProbability: 1,
            persona: { summary: "Test" }, backstory: { summary: "Test" },
        })),
    );
}

async function like(character, id) {
    const response = await fetch(`${baseUrl}/api/swipes`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "opener-user" },
        body: JSON.stringify({ characterId: String(character._id), clientSwipeId: `swipe-${id}-00000`, direction: "like" }),
    });
    return response.json();
}

it("schedules an opener with a bounded delay when a match is created", async () => {
    const [character] = await createCharacters(1);
    const before = Date.now();
    const { data } = await like(character, "a");
    expect(data.outcome).toBe("matched");
    const relationship = await RelationshipModel.findById(data.match._id).lean();
    expect(relationship.matchedAt).toBeInstanceOf(Date);
    const delay = relationship.openerDueAt.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(OPENER_MIN_DELAY_MS - 5);
    expect(delay).toBeLessThanOrEqual(OPENER_MAX_DELAY_MS + 1000);
    expect(relationship.openerSentAt).toBeUndefined();
});

it("caps pending openers so a burst of likes does not become a burst of pushes", async () => {
    const characters = await createCharacters(OPENER_MAX_PENDING + 2);
    for (const [i, character] of characters.entries()) await like(character, `b${i}`);
    const scheduled = await RelationshipModel.countDocuments({ openerDueAt: { $exists: true } });
    expect(scheduled).toBe(OPENER_MAX_PENDING);
    expect(await RelationshipModel.countDocuments()).toBe(OPENER_MAX_PENDING + 2);
});

it("worker sends the opener once it is due and marks it sent", async () => {
    const [character] = await createCharacters(1);
    const { data } = await like(character, "c");
    await RelationshipModel.updateOne({ _id: data.match._id }, { $set: { openerDueAt: new Date(Date.now() - 1000) } });

    await processDueOpeners({ llm });

    const messages = await MessageModel.find({ relationshipId: data.match._id }).lean();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].origin).toBe("initiated");
    expect(messages[0].content).toBe("hey");
    const relationship = await RelationshipModel.findById(data.match._id).lean();
    expect(relationship.openerSentAt).toBeInstanceOf(Date);
    expect(relationship.openerDueAt).toBeUndefined();

    // Running again must not send a second opener.
    await processDueOpeners({ llm });
    expect(await MessageModel.countDocuments({ relationshipId: data.match._id })).toBe(1);
});

it("does not send an opener if the user already started the conversation", async () => {
    const [character] = await createCharacters(1);
    const { data } = await like(character, "d");
    await MessageModel.create({
        relationshipId: data.match._id, sequenceNumber: 1, role: "user", content: "hi", status: "completed",
    });
    await RelationshipModel.updateOne({ _id: data.match._id }, { $set: { openerDueAt: new Date(Date.now() - 1000) } });

    await processDueOpeners({ llm });

    expect(await MessageModel.countDocuments({ relationshipId: data.match._id, role: "assistant" })).toBe(0);
    const relationship = await RelationshipModel.findById(data.match._id).lean();
    expect(relationship.openerSentAt).toBeInstanceOf(Date);
});

it("does not let clients request server-only triggers via /initiate", async () => {
    const [character] = await createCharacters(1);
    const { data } = await like(character, "e");
    for (const triggerType of ["opener", "check_in", "left_on_read"]) {
        const response = await fetch(`${baseUrl}/api/relationships/${data.match._id}/chat/initiate`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-user-id": "opener-user" },
            body: JSON.stringify({ triggerType }),
        });
        expect(response.status).toBe(400);
    }
});
