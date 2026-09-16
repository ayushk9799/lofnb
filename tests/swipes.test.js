import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { SwipeModel } from "../src/models/swipe.model.js";
import { UserModel } from "../src/models/user.model.js";

const models = [CharacterModel, RelationshipModel, SwipeModel, UserModel];
const env = {
  NODE_ENV: "test",
  ALLOW_DEV_AUTH: true,
  CORS_ORIGIN: "http://localhost:5173",
  MEMORY_VECTOR_SEARCH_ENABLED: false,
  MATCH_RATE: 0.4,
};

let database, server, baseUrl, matchingCharacter, nonMatchingCharacter;

beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all(models.map((model) => model.init()));
  server = createServer(createApp({ env, llm: {} }));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await database?.stop();
});

beforeEach(async () => {
  await Promise.all(models.map((model) => model.deleteMany({})));
  [matchingCharacter, nonMatchingCharacter] = await CharacterModel.create([
    {
      slug: "always-matches",
      name: "Maya",
      age: 28,
      matchProbability: 1,
      persona: { summary: "Painter" },
      backstory: { summary: "Lives in Mumbai" },
    },
    {
      slug: "never-matches",
      name: "Kai",
      age: 30,
      matchProbability: 0,
      persona: { summary: "Designer" },
      backstory: { summary: "Lives in Delhi" },
    },
  ]);
});

async function swipe(character, clientSwipeId, direction = "like") {
  const response = await fetch(`${baseUrl}/api/swipes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": "rapid-swiper",
    },
    body: JSON.stringify({
      characterId: String(character._id),
      clientSwipeId,
      direction,
      occurredAt: new Date().toISOString(),
    }),
  });
  return { response, body: await response.json() };
}

it("records a no-match like without creating a relationship", async () => {
  const { response, body } = await swipe(
    nonMatchingCharacter,
    "swipe-no-match-001",
  );
  expect(response.status).toBe(201);
  expect(body.data.outcome).toBe("recorded");
  expect(body.data.match).toBeNull();
  expect(await RelationshipModel.countDocuments()).toBe(0);
});

it("creates a relationship only for a confirmed match", async () => {
  const { response, body } = await swipe(matchingCharacter, "swipe-match-0001");
  expect(response.status).toBe(201);
  expect(body.data.outcome).toBe("matched");
  expect(body.data.match.characterId.name).toBe("Maya");
  expect(await RelationshipModel.countDocuments()).toBe(1);
});

it("replays the same persisted outcome for duplicate requests", async () => {
  const first = await swipe(matchingCharacter, "swipe-idempotent-1");
  const second = await swipe(matchingCharacter, "swipe-idempotent-1");
  expect(second.response.status).toBe(200);
  expect(second.body.data.swipeId).toBe(first.body.data.swipeId);
  expect(second.body.data.match._id).toBe(first.body.data.match._id);
  expect(await SwipeModel.countDocuments()).toBe(1);
  expect(await RelationshipModel.countDocuments()).toBe(1);
});

it("rejects reusing an idempotency key for another character", async () => {
  await swipe(matchingCharacter, "swipe-conflict-01");
  const conflict = await swipe(nonMatchingCharacter, "swipe-conflict-01");
  expect(conflict.response.status).toBe(409);
  expect(conflict.body.error.code).toBe("SWIPE_CONFLICT");
  expect(await SwipeModel.countDocuments()).toBe(1);
});

it("paginates discovery and never returns passed, liked, or matched profiles", async () => {
  const extraCharacters = await CharacterModel.create(
    Array.from({ length: 8 }, (_, index) => ({
      slug: `discovery-${index}`,
      name: `Profile ${index}`,
      age: 24 + index,
      matchProbability: 0,
      persona: {
        summary: `Profile ${index}`,
        personalityTraits: index % 2 === 0 ? ["Warm"] : ["Playful"],
      },
      backstory: { summary: `Backstory ${index}` },
    })),
  );
  await swipe(extraCharacters[1], "discovery-pass-01", "pass");
  await swipe(extraCharacters[2], "discovery-like-02", "like");
  await RelationshipModel.create({
    userId: "rapid-swiper",
    characterId: extraCharacters[3]._id,
  });

  const discovered = [];
  let cursor;
  do {
    const response = await fetch(
      `${baseUrl}/api/discovery?limit=3${cursor ? `&cursor=${cursor}` : ""}`,
      { headers: { "x-user-id": "rapid-swiper" } },
    );
    expect(response.status).toBe(200);
    const { data } = await response.json();
    discovered.push(...data.profiles.map((profile) => String(profile._id)));
    cursor = data.nextCursor;
    expect(data.hasMore).toBe(Boolean(cursor));
  } while (cursor);

  expect(new Set(discovered).size).toBe(discovered.length);
  expect(discovered).not.toContain(String(extraCharacters[1]._id));
  expect(discovered).not.toContain(String(extraCharacters[2]._id));
  expect(discovered).not.toContain(String(extraCharacters[3]._id));
  expect(discovered).toContain(String(extraCharacters[0]._id));
  expect(discovered).toContain(String(extraCharacters[7]._id));
});

it("applies saved discovery preferences on the server", async () => {
  await UserModel.create({
    userId: "rapid-swiper",
    minAge: 25,
    maxAge: 29,
    vibe: "Warm",
  });
  const [warm, tooOld, playful] = await CharacterModel.create([
    {
      slug: "warm-in-range",
      name: "Warm In Range",
      age: 27,
      persona: { summary: "Warm", personalityTraits: ["Warm"] },
      backstory: { summary: "Backstory" },
    },
    {
      slug: "warm-too-old",
      name: "Warm Too Old",
      age: 35,
      persona: { summary: "Warm", personalityTraits: ["Warm"] },
      backstory: { summary: "Backstory" },
    },
    {
      slug: "playful-in-range",
      name: "Playful In Range",
      age: 27,
      persona: { summary: "Playful", personalityTraits: ["Playful"] },
      backstory: { summary: "Backstory" },
    },
  ]);

  const response = await fetch(`${baseUrl}/api/discovery`, {
    headers: { "x-user-id": "rapid-swiper" },
  });
  const { data } = await response.json();
  const ids = data.profiles.map((profile) => String(profile._id));
  expect(ids).toContain(String(warm._id));
  expect(ids).not.toContain(String(tooOld._id));
  expect(ids).not.toContain(String(playful._id));
});
