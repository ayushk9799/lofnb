import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { PresenceSessionModel } from "../src/models/presence-session.model.js";
import {
  recordPresence,
  presenceContext,
} from "../src/services/presence.service.js";
import {
  classifyProactiveTrigger,
  processProactiveCheckIns,
} from "../src/workers/proactive.worker.js";
const models = [
  CharacterModel,
  RelationshipModel,
  MessageModel,
  PresenceSessionModel,
];
let database, relationship, latest, server, url;
const now = new Date();
const llm = {
  name: "fake",
  model: "fake",
  generateJson: async () => ({
    topic: "fresh opening",
    engagement: "uncertain",
    move: "share",
    reason: "A meaningful return",
    opening: "A new thought",
    media: "text",
  }),
  generateText: async () => "hey you. a little change of scenery today.",
};
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all(models.map((model) => model.init()));
  server = createServer(
    createApp({
      env: {
        NODE_ENV: "test",
        ALLOW_DEV_AUTH: true,
        DISABLE_CHAT_QUOTA: "true",
      },
      llm,
    }),
  );
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await database.stop();
});
beforeEach(async () => {
  await Promise.all(models.map((model) => model.deleteMany({})));
  const character = await CharacterModel.create({
    slug: "maya",
    name: "Maya",
    age: 26,
    persona: { summary: "Warm and playful" },
    backstory: { summary: "Lives in Brooklyn" },
  });
  relationship = await RelationshipModel.create({
    userId: "dev_user",
    characterId: character._id,
    lastMessageAt: new Date(+now - 2 * 86400000),
    lastInitiatedAt: new Date(+now - 2 * 86400000),
    nextSequence: 1,
  });
  latest = await MessageModel.create({
    relationshipId: relationship._id,
    sequenceNumber: 1,
    role: "assistant",
    origin: "initiated",
    content: "a previous opening",
    status: "completed",
    createdAt: new Date(+now - 2 * 86400000),
  });
});
const presence = (extra = {}) =>
  recordPresence({
    userId: "dev_user",
    sessionId: "test-session",
    foreground: true,
    relationshipId: relationship._id,
    now,
    ...extra,
  });
it("schedules a delayed return once and does not reset it on heartbeats or rapid reopens", async () => {
  await presence();
  const first = await RelationshipModel.findById(relationship._id).lean();
  expect(first.returnVisit.sourceSequence).toBe(1);
  expect(+first.returnVisit.dueAt - +now).toBeGreaterThanOrEqual(15000);
  expect(+first.returnVisit.dueAt - +now).toBeLessThanOrEqual(45000);
  await presence({ now: new Date(+now + 30000) });
  await presence({ foreground: false, now: new Date(+now + 40000) });
  await presence({ now: new Date(+now + 60000) });
  const next = await RelationshipModel.findById(relationship._id).lean();
  expect(next.returnVisit.startedAt).toEqual(first.returnVisit.startedAt);
});
it("does not schedule a chat greeting for app foreground alone or a brief chat absence", async () => {
  await presence({ relationshipId: null });
  expect(
    (await RelationshipModel.findById(relationship._id)).returnVisit.startedAt,
  ).toBeUndefined();
  await RelationshipModel.updateOne(
    { _id: relationship._id },
    { $set: { lastViewedAt: new Date(+now - 120000) } },
  );
  await presence();
  expect(
    (await RelationshipModel.findById(relationship._id)).returnVisit.startedAt,
  ).toBeUndefined();
});
it("expires online status without a background event and isolates multiple sessions", async () => {
  await presence();
  await presence({ sessionId: "second-session" });
  await presence({ foreground: false });
  expect(
    (await presenceContext("dev_user", relationship._id, now)).viewingChat,
  ).toBe(true);
  expect(
    (
      await presenceContext(
        "dev_user",
        relationship._id,
        new Date(+now + 91000),
      )
    ).appActive,
  ).toBe(false);
});
it("requires ownership and validates API input", async () => {
  await expect(presence({ userId: "someone_else" })).rejects.toThrow();
  expect(
    await PresenceSessionModel.countDocuments({ userId: "someone_else" }),
  ).toBe(0);
  const response = await fetch(`${url}/api/profile/presence`, {
    method: "POST",
    headers: { "x-user-id": "dev_user", "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "test-session",
      foreground: true,
      relationshipId: String(relationship._id),
    }),
  });
  expect(response.status).toBe(200);
  const bad = await fetch(`${url}/api/profile/presence`, {
    method: "POST",
    headers: { "x-user-id": "dev_user", "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "short", foreground: true }),
  });
  expect(bad.status).toBe(400);
});
it("allows a new return after an unanswered initiation and consumes the visit exactly once", async () => {
  await presence();
  await RelationshipModel.updateOne(
    { _id: relationship._id },
    { $set: { "returnVisit.dueAt": new Date(Date.now() - 1000) } },
  );
  const before = await RelationshipModel.findById(relationship._id).lean();
  expect(classifyProactiveTrigger(before, latest)).toBe("return_to_chat");
  await processProactiveCheckIns({ llm, env: { DISABLE_CHAT_QUOTA: "true" } });
  expect(
    await MessageModel.countDocuments({ relationshipId: relationship._id }),
  ).toBe(2);
  const after = await RelationshipModel.findById(relationship._id).lean();
  expect(after.returnVisit.processedAt).toBeDefined();
  await processProactiveCheckIns({ llm, env: { DISABLE_CHAT_QUOTA: "true" } });
  expect(
    await MessageModel.countDocuments({ relationshipId: relationship._id }),
  ).toBe(2);
});
it("does not greet after the user leaves, sends a new message, or asks for space", async () => {
  await presence();
  await RelationshipModel.updateOne(
    { _id: relationship._id },
    { $set: { "returnVisit.dueAt": new Date(Date.now() - 1000) } },
  );
  await presence({ foreground: false });
  await processProactiveCheckIns({ llm, env: { DISABLE_CHAT_QUOTA: "true" } });
  expect(await MessageModel.countDocuments()).toBe(1);
  const rel = await RelationshipModel.findById(relationship._id).lean();
  expect(
    classifyProactiveTrigger(
      { ...rel, turnState: { wantsSpace: true } },
      latest,
    ),
  ).toBeNull();
  expect(
    classifyProactiveTrigger(rel, {
      ...latest.toObject(),
      sequenceNumber: 2,
      createdAt: new Date(),
    }),
  ).toBeNull();
});
it("can reconnect after a day without chasing repeatedly in the same pause", () => {
  expect(classifyProactiveTrigger(relationship.toObject(), latest)).toBe(
    "callback",
  );
  expect(
    classifyProactiveTrigger(
      { ...relationship.toObject(), lastInitiatedAt: new Date() },
      latest,
    ),
  ).toBeNull();
});
