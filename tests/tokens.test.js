import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  normalizeMemoryKey,
  takeNewestWithinTokenBudget,
} from "../src/utils/tokens.js";

describe("context token budgeting", () => {
  it("keeps the newest messages but returns them chronologically", () => {
    const newestFirst = [
      { role: "assistant", content: "newest response" },
      { role: "user", content: "recent question" },
      { role: "assistant", content: "older response" },
    ];

    const selected = takeNewestWithinTokenBudget(newestFirst, 17);

    expect(selected).toEqual([
      { role: "user", content: "recent question" },
      { role: "assistant", content: "newest response" },
    ]);
  });

  it("truncates a single oversized newest message", () => {
    const selected = takeNewestWithinTokenBudget(
      [{ role: "user", content: "x".repeat(100) }],
      10,
    );
    expect(selected[0]?.content).toHaveLength(24);
  });

  it("uses a conservative character estimate", () => {
    expect(estimateTokens("12345")).toBe(2);
  });
});

describe("memory keys", () => {
  it("normalizes keys for relationship-local deduplication", () => {
    expect(normalizeMemoryKey(" User's Favorite Coffee ")).toBe(
      "user_s_favorite_coffee",
    );
  });
});
