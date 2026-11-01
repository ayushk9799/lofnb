import { afterEach, expect, it, vi } from "vitest";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { UserModel } from "../src/models/user.model.js";
import { ensureProfileMemory } from "../src/services/context.service.js";

afterEach(() => vi.restoreAllMocks());

it("captures the first profile snapshot after describing its photo and preserves it on updates", async () => {
    const relationship = { profileMemory: {}, save: vi.fn(), markModified: vi.fn() };
    const user = { bio: "film photography", avatarUrl: "https://r2.lofnchat.com/profile-context-test.png" };
    vi.spyOn(RelationshipModel, "findOne").mockResolvedValue(relationship);
    vi.spyOn(UserModel, "findOne").mockImplementation(() => ({select: () => ({lean: async () => user})}));
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ok: true, headers: new Headers({"content-type": "image/png"}), arrayBuffer: async () => new Uint8Array([1, 2]).buffer});
    const llm = {generateText: vi.fn().mockResolvedValue("A person wearing a blue jacket.")};
    await ensureProfileMemory({relationshipId: "test", userId: "test", llm});
    expect(relationship.matchProfile).toMatchObject({bio: "film photography", photoNote: "A person wearing a blue jacket."});
    const snapshot = {...relationship.matchProfile};
    user.bio = "cooking";
    await ensureProfileMemory({relationshipId: "test", userId: "test", llm});
    expect(relationship.profileMemory.bio).toBe("cooking");
    expect(relationship.matchProfile).toEqual(snapshot);
    expect(llm.generateText).toHaveBeenCalledTimes(1);
});

it("captures an empty profile without requiring a photo or model call", async () => {
    const relationship = {profileMemory: {}, save: vi.fn(), markModified: vi.fn()};
    vi.spyOn(RelationshipModel, "findOne").mockResolvedValue(relationship);
    vi.spyOn(UserModel, "findOne").mockImplementation(() => ({select: () => ({lean: async () => ({bio: "", avatarUrl: ""})})}));
    const llm = {generateText: vi.fn()};
    await ensureProfileMemory({relationshipId: "test", userId: "test", llm});
    expect(relationship.matchProfile).toMatchObject({bio: "", photoNote: ""});
    expect(llm.generateText).not.toHaveBeenCalled();
});
