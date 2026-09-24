import { expect, it } from "vitest";
import { buildDossier, dossierContext, groundedDossierMetadata } from "../src/services/dossier.service.js";
import { datedHistoryContent } from "../src/services/context.service.js";
const now = new Date("2026-09-23T09:00:00Z");
const memory = { _id: "one", normalizedKey: "user_coffee", dossierCategory: "preference", text: "Likes black coffee", status: "active", confidence: 0.9, importance: 0.8 };

it("requires actual user evidence for personal facts and jokes", () => {
  const value = { type: "shared_event", dossierCategory: "inside_joke", evidence: "coffee goblin" };
  expect(groundedDossierMetadata(value, {content: "hello"}, now).dossierCategory).toBeUndefined();
  expect(groundedDossierMetadata(value, undefined, now).dossierCategory).toBeUndefined();
  expect(groundedDossierMetadata(value, {content: "haha coffee goblin is us"}, now).dossierCategory).toBe("inside_joke");
});
it("expires temporary context and marks recent callbacks without losing stable facts", () => {
  const value = {type: "user_fact", dossierCategory: "current_life", evidence: "interview", expiresAt: "invalid"};
  const metadata = groundedDossierMetadata(value, {content: "interview tomorrow"}, now);
  expect(metadata.expiresAt.toISOString()).toBe("2026-09-30T09:00:00.000Z");
  const dossier = buildDossier([
    {...memory, lastMentionedAt: now},
    {...memory, _id: "expired", dossierCategory: "current_life", expiresAt: new Date("2026-09-22")},
    {...memory, _id: "deleted", status: "deleted"},
    {...memory, _id: "guess", confidence: 0.3},
  ], now);
  expect(dossier.entries).toHaveLength(1);
  expect(dossierContext(dossier, now)[0].recentlyMentioned).toBe(true);
  expect(dossierContext({entries: [{...memory, expiresAt: metadata.expiresAt}]}, new Date("2026-10-01"))).toEqual([]);
});
it("bounds the dossier with category quotas and never truncates facts", () => {
  const dossier = buildDossier(Array.from({length: 100}, (_, i) => ({...memory, _id: String(i), text: "x".repeat(400)})), now);
  expect(dossier.entries).toHaveLength(4);
  expect(dossier.entries.every(e => e.text.length === 400)).toBe(true);
});
it("formats history with dates in the user's timezone and a safe UTC fallback", () => {
  expect(datedHistoryContent("hello", now, "Asia/Kolkata")).toBe("[Sent 23 Sept 2026, 14:30 (Asia/Kolkata)]\nhello");
  expect(datedHistoryContent("hello", now, "bad-zone")).toContain(now.toISOString());
  expect(datedHistoryContent("", now)).toBe("");
});
