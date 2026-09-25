import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { analyticsRouter } from "../src/routes/analytics.routes.js";
import { UserModel } from "../src/models/user.model.js";
import { SwipeModel } from "../src/models/swipe.model.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";

function createMockReqRes({ method = "GET", url = "/", query = {}, params = {}, headers = {} } = {}) {
  const req = {
    method,
    url,
    query,
    params,
    headers,
    header(name) {
      return headers[name.toLowerCase()];
    },
  };

  let statusCode = 200;
  let jsonBody = null;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      jsonBody = data;
      return res;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return jsonBody;
    },
  };

  return { req, res };
}

// Helper to execute router handler matching path
async function invokeRoute(path, query = {}, params = {}) {
  const { req, res } = createMockReqRes({ query, params });
  const route = analyticsRouter.stack.find((layer) => layer.route && layer.route.path === path);
  if (!route) throw new Error(`Route not found for path: ${path}`);
  const handler = route.route.stack[0].handle;
  await new Promise((resolve, reject) => {
    handler(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    }).then(resolve).catch(reject);
  });
  return { statusCode: res.statusCode, body: res.body };
}

describe("Analytics Routes (/api/analytics)", () => {
  let mongod;

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  });

  afterEach(async () => {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  it("returns summary metrics and trends", async () => {
    const character = await CharacterModel.create({
      slug: "test-char",
      name: "Test Companion",
      age: 24,
      gender: "female",
      persona: { summary: "Test persona" },
      backstory: { summary: "Test backstory" },
    });

    await UserModel.create([
      { userId: "user_1", email: "user1@example.com", name: "User One", platform: "ios", isPremium: true },
      { userId: "user_2", email: "user2@example.com", name: "User Two", platform: "android", isPremium: false },
    ]);

    await SwipeModel.create([
      { userId: "user_1", characterId: character._id, clientSwipeId: "swipe_1", direction: "like", outcome: "matched" },
      { userId: "user_2", characterId: character._id, clientSwipeId: "swipe_2", direction: "pass", outcome: "recorded" },
    ]);

    const rel = await RelationshipModel.create({
      userId: "user_1",
      characterId: character._id,
      stage: "friends",
      mood: "playful",
    });

    await MessageModel.create([
      { relationshipId: rel._id, sequenceNumber: 1, role: "user", content: "Hey there!", status: "completed" },
      { relationshipId: rel._id, sequenceNumber: 2, role: "assistant", content: "Hello! How are you?", status: "completed" },
    ]);

    const res = await invokeRoute("/summary", { days: "7" });

    expect(res.statusCode).toBe(200);
    expect(res.body.totalUsers).toBe(2);
    expect(res.body.premiumUsers).toBe(1);
    expect(res.body.conversionRate).toBe(50);
    expect(res.body.totalSwipes).toBe(2);
    expect(res.body.likesCount).toBe(1);
    expect(res.body.passesCount).toBe(1);
    expect(res.body.likeRatio).toBe(50);
    expect(res.body.totalMatches).toBe(1);
    expect(res.body.totalMessages).toBe(2);
    expect(res.body.userMessages).toBe(1);
    expect(res.body.assistantMessages).toBe(1);
    expect(Array.isArray(res.body.trends)).toBe(true);
    expect(res.body.trends.length).toBeGreaterThan(0);
  });

  it("returns paginated users with activity metrics", async () => {
    const character = await CharacterModel.create({
      slug: "companion-beta",
      name: "Beta Companion",
      age: 22,
      gender: "female",
      persona: { summary: "Beta persona" },
      backstory: { summary: "Beta backstory" },
    });

    await UserModel.create({
      userId: "active_user",
      email: "active@example.com",
      name: "Active Swiper",
      platform: "ios",
    });

    await SwipeModel.create({
      userId: "active_user",
      characterId: character._id,
      clientSwipeId: "sw_101",
      direction: "like",
      outcome: "matched",
    });

    const rel = await RelationshipModel.create({
      userId: "active_user",
      characterId: character._id,
      stage: "new",
      mood: "neutral",
    });

    await MessageModel.create({
      relationshipId: rel._id,
      sequenceNumber: 1,
      role: "user",
      content: "First message",
      status: "completed",
    });

    const res = await invokeRoute("/users", { page: "1", limit: "10" });

    expect(res.statusCode).toBe(200);
    expect(res.body.users.length).toBe(1);
    const u = res.body.users[0];
    expect(u.userId).toBe("active_user");
    expect(u.email).toBe("active@example.com");
    expect(u.swipesCount).toBe(1);
    expect(u.likesCount).toBe(1);
    expect(u.matchesCount).toBe(1);
    expect(u.messagesCount).toBe(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("returns drilldown user details", async () => {
    const character = await CharacterModel.create({
      slug: "companion-gamma",
      name: "Gamma Companion",
      age: 26,
      gender: "female",
      persona: { summary: "Gamma persona" },
      backstory: { summary: "Gamma backstory" },
    });

    await UserModel.create({
      userId: "user_gamma",
      email: "gamma@example.com",
      name: "Gamma User",
      platform: "web",
    });

    const rel = await RelationshipModel.create({
      userId: "user_gamma",
      characterId: character._id,
      stage: "romantic",
      mood: "happy",
    });

    await MessageModel.create({
      relationshipId: rel._id,
      sequenceNumber: 1,
      role: "user",
      content: "Loving this!",
      status: "completed",
    });

    const res = await invokeRoute("/users/:userId", {}, { userId: "user_gamma" });

    expect(res.statusCode).toBe(200);
    expect(res.body.user.userId).toBe("user_gamma");
    expect(res.body.relationships.length).toBe(1);
    expect(res.body.relationships[0].character.name).toBe("Gamma Companion");
    expect(res.body.relationships[0].stage).toBe("romantic");
    expect(res.body.relationships[0].userMessages).toBe(1);
  });
});
