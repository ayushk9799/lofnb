import { expect, it } from "vitest";
import {
  resolveCompanionMedia,
  visibleTurnContent,
} from "../src/services/companion-media.service.js";

it("labels sent and refused media in history so later turns can see it", () => {
  expect(visibleTurnContent("", "image")).toBe("[sent a photo]");
  expect(visibleTurnContent("this one's from last week.", "image")).toBe(
    "this one's from last week. [sent a photo]",
  );
  expect(visibleTurnContent("", "audio")).toBe("[sent a voice note]");
  expect(visibleTurnContent("nah", undefined, "image_refused")).toBe(
    "nah [refused a photo]",
  );
  expect(visibleTurnContent("later", undefined, "audio_refused")).toBe(
    "later [refused a voice note]",
  );
  expect(visibleTurnContent("hey", undefined)).toBe("hey");
});

it("attaches a photo only when she called send_photo with a real description", () => {
  expect(resolveCompanionMedia({
    toolPhoto: { action: "send", query: "walnut table being sanded in the shop" },
    replyText: "this one's from last week.",
  })).toEqual({
    photo: { query: "walnut table being sanded in the shop" },
    voice: null,
    decision: "image_sent",
  });
});

it("does not attach a photo for a compliment with no tool call", () => {
  expect(resolveCompanionMedia({
    userText: "You look so pretty yaar",
    replyText: "thanks",
  })).toEqual({ photo: null, voice: null, decision: "text" });
});

it("does not attach when she called refuse_photo", () => {
  expect(resolveCompanionMedia({
    toolPhoto: { action: "refuse", reason: "don't send pics to strangers" },
    userText: "Send pic na",
    replyText: "nah not sending pics to strangers just yet",
  })).toEqual({ photo: null, voice: null, decision: "image_refused" });
});

it("does not treat a skipped photo tool as a send when they asked", () => {
  expect(resolveCompanionMedia({
    photoNeeded: true,
    userText: "Send pic na",
    replyText: "still no. this isn't changing.",
  })).toEqual({ photo: null, voice: null, decision: "image_refused" });
});

it("does not treat a refusal sentence as a photo send", () => {
  const refusal = "not really into sending pics to strangers just yet";
  expect(resolveCompanionMedia({
    toolPhoto: { query: refusal },
    photoNeeded: true,
    userText: "Send pic na",
    replyText: refusal,
  })).toEqual({ photo: null, voice: null, decision: "image_refused" });
});

it("attaches a photo if the text claims she sent one but she forgot the tool", () => {
  expect(resolveCompanionMedia({
    userText: "Please do it",
    replyText: "fine. here's another. don't get used to it.",
  })).toEqual({
    photo: { query: "a candid moment from my day" },
    voice: null,
    decision: "image_sent",
  });
});

it("attaches audio only from send_voice_note", () => {
  expect(resolveCompanionMedia({
    toolVoice: { action: "send", spoken: "hey, wrapping the table now" },
    replyText: "one sec",
  })).toEqual({
    photo: null,
    voice: { spoken: "hey, wrapping the table now" },
    decision: "audio_sent",
  });
  expect(resolveCompanionMedia({
    voiceNeeded: true,
    userText: "send a voice note",
    replyText: "sure, wrapping up at the shop.",
  })).toEqual({ photo: null, voice: null, decision: "audio_refused" });
});

it("does not attach when she called refuse_voice_note", () => {
  expect(resolveCompanionMedia({
    toolVoice: { action: "refuse", reason: "can't talk right now" },
    userText: "send a voice note",
    replyText: "can't talk, texting",
  })).toEqual({ photo: null, voice: null, decision: "audio_refused" });
});
