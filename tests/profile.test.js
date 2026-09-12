import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { UserModel } from "../src/models/user.model.js";

let database, app;
const env = {
    NODE_ENV: "test",
    ALLOW_DEV_AUTH: true,
    CORS_ORIGIN: "http://localhost:5173",
    MEMORY_VECTOR_SEARCH_ENABLED: false,
};

beforeAll(async () => {
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(database.getUri());
    await UserModel.init();
    app = createApp({ env, llm: {}, embeddingProvider: {} });
});

afterAll(async () => {
    await mongoose.disconnect();
    await database?.stop();
});

beforeEach(async () => {
    await UserModel.deleteMany({});
});

describe("User Profile Endpoints", () => {
    it("returns default profile when none exists", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/api/profile`, {
                headers: { "x-user-id": "user-default-1" },
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.data).toMatchObject({
                userId: "user-default-1",
                name: "",
                bio: "",
                vibe: "Everyone",
                minAge: 18,
                maxAge: 60,
            });
        } finally {
            server.close();
        }
    });

    it("updates and persists profile fields via PATCH /api/profile", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/api/profile`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "x-user-id": "user-update-1",
                },
                body: JSON.stringify({
                    name: "Alex",
                    bio: "Exploring the world",
                    vibe: "Creative",
                    minAge: 24,
                    maxAge: 35,
                }),
            });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.data).toMatchObject({
                userId: "user-update-1",
                name: "Alex",
                bio: "Exploring the world",
                vibe: "Creative",
                minAge: 24,
                maxAge: 35,
            });

            const inDb = await UserModel.findOne({ userId: "user-update-1" }).lean();
            expect(inDb.name).toBe("Alex");
            expect(inDb.vibe).toBe("Creative");
            expect(inDb.minAge).toBe(24);
        } finally {
            server.close();
        }
    });

    it("rejects invalid age ranges with 400 validation error", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/api/profile`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "x-user-id": "user-invalid-1",
                },
                body: JSON.stringify({
                    minAge: 50,
                    maxAge: 25,
                }),
            });
            expect(res.status).toBe(400);
        } finally {
            server.close();
        }
    });
});
