import { expect, it } from "vitest";
import {
  buildCompanionImagePrompt,
  decideCompanionPhoto,
  extractPhotoIntent,
  matchGalleryPhoto,
  userAskedForPhoto,
} from "../src/services/companion-photo.service.js";

it("strips a photo tag and keeps the visible text", () => {
  const parsed = extractPhotoIntent(
    "sanding a walnut table for a client.\n%%PHOTO scene | walnut dining table being sanded in a workshop%%",
  );
  expect(parsed.content).toBe("sanding a walnut table for a client.");
  expect(parsed.intent).toEqual({
    kind: "scene",
    query: "walnut dining table being sanded in a workshop",
  });
});

it("returns no intent when the model did not tag a photo", () => {
  expect(extractPhotoIntent("just at the shop.").intent).toBeNull();
});

it("parses a photo tag even when the model forgets the closing marker", () => {
  const parsed = extractPhotoIntent("%%PHOTO gallery | walnut table in the shop");
  expect(parsed.intent).toEqual({
    kind: "gallery",
    query: "walnut table in the shop",
  });
  expect(parsed.content).toBe("");
});

it("detects explicit photo asks and ignores ordinary chat", () => {
  expect(userAskedForPhoto("send a pic of the table")).toBe(true);
  expect(userAskedForPhoto("what does it look like?")).toBe(true);
  expect(userAskedForPhoto("can i see it")).toBe(true);
  expect(userAskedForPhoto("what build")).toBe(false);
  expect(userAskedForPhoto("just finishing up a build")).toBe(false);
});

it("matches a gallery photo by caption keywords and ignores unrelated shots", () => {
  const gallery = [
    { url: "/selfies/1.jpg", caption: "Sunday coffee" },
    { url: "/shop/table.jpg", caption: "Walnut dining table in the workshop" },
  ];
  expect(matchGalleryPhoto(gallery, "walnut table workshop").url).toBe("/shop/table.jpg");
  expect(matchGalleryPhoto(gallery, "my dog at the beach")).toBeNull();
});

it("sends on a tag or an explicit ask, and respects cooldown unless asked", () => {
  expect(decideCompanionPhoto({ intent: { kind: "scene", query: "shop" }, asked: false, rateLimited: false }))
    .toEqual({ kind: "scene", query: "shop" });
  expect(decideCompanionPhoto({ intent: null, asked: true, rateLimited: true }))
    .toEqual({ kind: "scene", query: "" });
  expect(decideCompanionPhoto({ intent: { kind: "scene", query: "shop" }, asked: false, rateLimited: true }))
    .toBeNull();
  expect(decideCompanionPhoto({ intent: null, asked: false, rateLimited: false })).toBeNull();
});

it("builds a candid phone-photo prompt from character and scene", () => {
  const prompt = buildCompanionImagePrompt(
    {
      name: "Kai Chen",
      age: 34,
      occupation: "Furniture maker",
      ethnicity: "East Asian",
      gallery: [{ caption: "short dark hair, work shirt" }],
    },
    "walnut dining table being sanded",
  );
  expect(prompt).toContain("Kai Chen");
  expect(prompt).toContain("walnut dining table being sanded");
  expect(prompt).toContain("Candid smartphone photo");
  expect(prompt).not.toContain("cinematic masterpiece");
});
