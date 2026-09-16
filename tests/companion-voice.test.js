import { expect, it } from "vitest";
import {
  decideCompanionVoice,
  estimateSpeechDurationMs,
  extractVoiceIntent,
  looksLikeVoiceRefusal,
  userAskedForVoice,
} from "../src/services/companion-voice.service.js";

it("strips a voice tag and keeps the visible text", () => {
  const parsed = extractVoiceIntent("one sec\n%%VOICE | hey, wrapping the table now%%");
  expect(parsed.content).toBe("one sec");
  expect(parsed.intent).toEqual({
    kind: "voice",
    spoken: "hey, wrapping the table now",
  });
});

it("parses a voice tag without spoken script or closing marker", () => {
  expect(extractVoiceIntent("%%VOICE").intent).toEqual({ kind: "voice", spoken: "" });
  expect(extractVoiceIntent("%%VOICE | on my way").intent.spoken).toBe("on my way");
});

it("detects explicit voice asks and ignores ordinary chat", () => {
  expect(userAskedForVoice("send a voice note")).toBe(true);
  expect(userAskedForVoice("can you send me a voicenote")).toBe(true);
  expect(userAskedForVoice("drop a voice")).toBe(true);
  expect(userAskedForVoice("send the pic")).toBe(false);
  expect(userAskedForVoice("what build")).toBe(false);
});

it("only sends a voice note when the model decided to", () => {
  expect(decideCompanionVoice({ intent: { kind: "voice", spoken: "hey" } }))
    .toEqual({ kind: "voice", spoken: "hey" });
  expect(decideCompanionVoice({ intent: null })).toBeNull();
});

it("estimates a short spoken duration from word count", () => {
  expect(estimateSpeechDurationMs("hey")).toBeGreaterThanOrEqual(1200);
  expect(estimateSpeechDurationMs("hey wrapping this walnut table before I head out")).toBeGreaterThan(
    estimateSpeechDurationMs("hey"),
  );
});

it("flags refusals so an asked voice note still gets synthesized", () => {
  expect(looksLikeVoiceRefusal("i can't send voice notes")).toBe(true);
  expect(looksLikeVoiceRefusal("wrapping up at the shop")).toBe(false);
});
