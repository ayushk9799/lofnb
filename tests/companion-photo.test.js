import { expect, it } from "vitest";
import {
  buildCompanionImagePrompt,
  collectCameraRoll,
  decideCompanionPhoto,
  extractPhotoIntent,
  looksLikePhotoFollowUp,
  matchGalleryPhoto,
  pickCameraRollPhoto,
  replyRefusesPhoto,
  userAskedForPhoto,
} from "../src/services/companion-photo.service.js";

it("strips a photo tag and keeps the visible text", () => {
  const parsed = extractPhotoIntent(
    "sanding a walnut table for a client.\n%%PHOTO scene | walnut dining table being sanded in a workshop%%",
  );
  expect(parsed.content).toBe("sanding a walnut table for a client.");
  expect(parsed.intent).toEqual({
    query: "walnut dining table being sanded in a workshop",
  });
});

it("treats short pushes as photo follow-ups", () => {
  expect(looksLikePhotoFollowUp("Please")).toBe(true);
  expect(looksLikePhotoFollowUp("Send na")).toBe(true);
  expect(userAskedForPhoto("Send na")).toBe(true);
  expect(looksLikePhotoFollowUp("hey")).toBe(false);
  expect(userAskedForPhoto("Send voice note na")).toBe(false);
  expect(looksLikePhotoFollowUp("Send audio please")).toBe(false);
  expect(replyRefusesPhoto("still no. i'm not sending a personal photo.")).toBe(true);
});

it("returns no intent when the model did not tag a photo", () => {
  expect(extractPhotoIntent("just at the shop.").intent).toBeNull();
});

it("parses a photo tag even when the model forgets the closing marker", () => {
  const parsed = extractPhotoIntent("%%PHOTO gallery | walnut table in the shop");
  expect(parsed.intent).toEqual({ query: "walnut table in the shop" });
  expect(parsed.content).toBe("");
});

it("matches an existing photo by caption when the description lines up", () => {
  const gallery = [
    { url: "/selfies/1.jpg", caption: "Sunday coffee" },
    { url: "/shop/table.jpg", caption: "Walnut dining table in the workshop" },
  ];
  expect(matchGalleryPhoto(gallery, "walnut table workshop").url).toBe("/shop/table.jpg");
  expect(matchGalleryPhoto(gallery, "my dog at the beach")).toBeNull();
});

it("only sends a photo when there is something to show", () => {
  expect(decideCompanionPhoto({ intent: { query: "the view from the stoop" } }))
    .toEqual({ query: "the view from the stoop" });
  expect(decideCompanionPhoto({ intent: null })).toBeNull();
});
it("builds a prompt from what the photo shows", () => {
  const prompt = buildCompanionImagePrompt(
    {
      name: "Kai Chen",
      age: 34,
      occupation: "Furniture maker",
      ethnicity: "East Asian",
    },
    "walnut dining table being sanded",
  );
  expect(prompt).toContain("walnut dining table being sanded");
  expect(prompt).toContain("Exactly one smartphone photograph");
  expect(prompt).not.toContain("cinematic masterpiece");
});

it("collects existing photos without picking one at random for a matching caption", () => {
  const roll = collectCameraRoll({
    avatarUrl: "/maya/avatar.jpg",
    photos: ["/maya/1.jpg", "/maya/2.jpg"],
    gallery: [{ url: "/maya/cafe.jpg", caption: "cafe window" }],
  });
  expect(roll.map((item) => item.url)).toEqual([
    "/maya/cafe.jpg",
    "/maya/1.jpg",
    "/maya/2.jpg",
    "/maya/avatar.jpg",
  ]);
  expect(pickCameraRollPhoto(roll, "cafe window").url).toBe("/maya/cafe.jpg");
});
