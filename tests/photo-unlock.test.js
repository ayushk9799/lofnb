import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { UserModel } from "../src/models/user.model.js";
import { PHOTO_UNLOCK_COST } from "../src/services/companion-photo.service.js";

const env = {
  NODE_ENV: "test",
  ALLOW_DEV_AUTH: true,
  CORS_ORIGIN: "http://localhost:5173",
  MEMORY_VECTOR_SEARCH_ENABLED: false,
  REVENUECAT_PROJECT_ID: "proj_test",
  REVENUECAT_SECRET_KEY: "sk_test_secret",
};

const models = [CharacterModel, RelationshipModel, MessageModel, UserModel];
let database, character, relationship, server, baseUrl;

beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all(models.map((model) => model.init()));
  server = createServer(createApp({ env, llm: {} }));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect().catch(() => {});
  await database?.stop?.();
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
    nextSequence: 2,
  });
  await UserModel.create({
    userId: "alice",
    revenueCatAppUserId: "rc_alice",
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const realFetch = globalThis.fetch.bind(globalThis);

function revenueCatCalls() {
  return globalThis.fetch.mock?.calls?.filter(([url]) => String(url).includes("revenuecat.com")) || [];
}

function mockRevenueCat({ ok = true, status = 200, balance = 1, message } = {}) {
  globalThis.fetch = vi.fn(async (url, options) => {
    if (String(url).includes("revenuecat.com")) {
      return {
        ok,
        status,
        json: async () => (
          ok
            ? { items: [{ currency_code: "GEMS", balance }] }
            : { message: message || "Customer's balance is not enough to perform the transaction." }
        ),
      };
    }
    return realFetch(url, options);
  });
}

async function createLockedPhoto() {
  return MessageModel.create({
    relationshipId: relationship._id,
    sequenceNumber: 1,
    role: "assistant",
    content: "this one.",
    status: "completed",
    mediaType: "image",
    mediaUrl: "https://example.com/locked.png",
    mediaMeta: { locked: true, unlockCost: PHOTO_UNLOCK_COST, source: "generated" },
  });
}

it("unlocks a locked photo by spending 99 hearts", async () => {
  const message = await createLockedPhoto();
  mockRevenueCat({ balance: 1 });

  const res = await fetch(
    `${baseUrl}/api/relationships/${relationship._id}/messages/${message._id}/unlock`,
    { method: "POST", headers: { "content-type": "application/json", "x-user-id": "alice" }, body: "{}" },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.spent).toBe(99);
  expect(body.data.remainingGems).toBe(1);
  expect(body.data.mediaMeta.locked).toBe(false);
  expect(body.data.alreadyUnlocked).toBe(false);

  const saved = await MessageModel.findById(message._id).lean();
  expect(saved.mediaMeta.locked).toBe(false);
  expect(saved.mediaMeta.unlockedAt).toBeTruthy();
  expect(revenueCatCalls()).toHaveLength(1);
});

it("does not spend again when the photo is already unlocked", async () => {
  const message = await createLockedPhoto();
  mockRevenueCat({ balance: 1 });
  const url = `${baseUrl}/api/relationships/${relationship._id}/messages/${message._id}/unlock`;
  const headers = { "content-type": "application/json", "x-user-id": "alice" };
  await fetch(url, { method: "POST", headers, body: "{}" });
  const again = await fetch(url, { method: "POST", headers, body: "{}" });
  expect(again.status).toBe(200);
  const body = await again.json();
  expect(body.data.alreadyUnlocked).toBe(true);
  expect(body.data.spent).toBe(0);
  expect(revenueCatCalls()).toHaveLength(1);
});

it("rejects unlocking a user photo", async () => {
  const message = await MessageModel.create({
    relationshipId: relationship._id,
    sequenceNumber: 1,
    role: "user",
    content: "look",
    status: "completed",
    mediaType: "image",
    mediaUrl: "https://example.com/me.png",
  });
  const res = await fetch(
    `${baseUrl}/api/relationships/${relationship._id}/messages/${message._id}/unlock`,
    { method: "POST", headers: { "content-type": "application/json", "x-user-id": "alice" }, body: "{}" },
  );
  expect(res.status).toBe(404);
});

it("returns insufficient balance without unlocking", async () => {
  const message = await createLockedPhoto();
  mockRevenueCat({
    ok: false,
    status: 422,
    message: "Customer's balance is not enough to perform the transaction.",
  });
  const res = await fetch(
    `${baseUrl}/api/relationships/${relationship._id}/messages/${message._id}/unlock`,
    { method: "POST", headers: { "content-type": "application/json", "x-user-id": "alice" }, body: "{}" },
  );
  expect(res.status).toBe(422);
  const saved = await MessageModel.findById(message._id).lean();
  expect(saved.mediaMeta.locked).toBe(true);
});

async function createLockedVoice() {
  return MessageModel.create({
    relationshipId: relationship._id,
    sequenceNumber: 1,
    role: "assistant",
    content: "one sec",
    status: "completed",
    mediaType: "audio",
    mediaUrl: "https://example.com/locked.mp3",
    mediaMeta: { locked: true, unlockCost: 50, source: "generated", transcript: "hey" },
  });
}

it("unlocks a locked voice note by spending 50 hearts", async () => {
  const message = await createLockedVoice();
  mockRevenueCat({ balance: 20 });

  const res = await fetch(
    `${baseUrl}/api/relationships/${relationship._id}/messages/${message._id}/unlock`,
    { method: "POST", headers: { "content-type": "application/json", "x-user-id": "alice" }, body: "{}" },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.spent).toBe(50);
  expect(body.data.remainingGems).toBe(20);
  expect(body.data.mediaMeta.locked).toBe(false);
  expect(body.data.alreadyUnlocked).toBe(false);

  const saved = await MessageModel.findById(message._id).lean();
  expect(saved.mediaMeta.locked).toBe(false);
  expect(saved.mediaMeta.unlockedAt).toBeTruthy();
  expect(revenueCatCalls()).toHaveLength(1);
});

it("does not spend again when the voice note is already unlocked", async () => {
  const message = await createLockedVoice();
  mockRevenueCat({ balance: 20 });
  const url = `${baseUrl}/api/relationships/${relationship._id}/messages/${message._id}/unlock`;
  const headers = { "content-type": "application/json", "x-user-id": "alice" };
  await fetch(url, { method: "POST", headers, body: "{}" });
  const again = await fetch(url, { method: "POST", headers, body: "{}" });
  expect(again.status).toBe(200);
  const body = await again.json();
  expect(body.data.alreadyUnlocked).toBe(true);
  expect(body.data.spent).toBe(0);
  expect(revenueCatCalls()).toHaveLength(1);
});

it("rejects unlocking a user voice note", async () => {
  const message = await MessageModel.create({
    relationshipId: relationship._id,
    sequenceNumber: 1,
    role: "user",
    content: "listen",
    status: "completed",
    mediaType: "audio",
    mediaUrl: "https://example.com/me.mp3",
  });
  const res = await fetch(
    `${baseUrl}/api/relationships/${relationship._id}/messages/${message._id}/unlock`,
    { method: "POST", headers: { "content-type": "application/json", "x-user-id": "alice" }, body: "{}" },
  );
  expect(res.status).toBe(404);
});

it("returns insufficient balance without unlocking a voice note", async () => {
  const message = await createLockedVoice();
  mockRevenueCat({
    ok: false,
    status: 422,
    message: "Customer's balance is not enough to perform the transaction.",
  });
  const res = await fetch(
    `${baseUrl}/api/relationships/${relationship._id}/messages/${message._id}/unlock`,
    { method: "POST", headers: { "content-type": "application/json", "x-user-id": "alice" }, body: "{}" },
  );
  expect(res.status).toBe(422);
  const saved = await MessageModel.findById(message._id).lean();
  expect(saved.mediaMeta.locked).toBe(true);
});
