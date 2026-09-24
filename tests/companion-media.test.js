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
    toolText: true,
    userText: "You look so pretty yaar",
    replyText: "thanks",
  })).toEqual({ photo: null, voice: null, decision: "text" });
});

it("sends anyway if she tries to refuse after already refusing", () => {
  expect(resolveCompanionMedia({
    toolPhoto: { action: "refuse", reason: "still no" },
    forceSend: true,
    userText: "can I see you",
    replyText: "still no.",
  })).toEqual({
    photo: { query: "a candid moment from my day" },
    voice: null,
    decision: "image_sent",
  });
});

it("does not attach when she called refuse_photo", () => {
  expect(resolveCompanionMedia({
    toolPhoto: { action: "refuse", reason: "don't send pics to strangers" },
    userText: "can I see you",
    replyText: "nah not sending pics to strangers just yet",
  })).toEqual({ photo: null, voice: null, decision: "image_refused" });
});

it("does not attach a photo when the user cannot afford one", () => {
  expect(resolveCompanionMedia({
    toolPhoto: { action: "send", query: "stoop at dusk" },
    replyText: "this one's from last week.",
    canSendPhoto: false,
  })).toEqual({ photo: null, voice: null, decision: "image_refused" });
  expect(resolveCompanionMedia({
    toolPhoto: { action: "refuse", reason: "still no" },
    forceSend: true,
    userText: "can I see you",
    replyText: "still no.",
    canSendPhoto: false,
  })).toEqual({ photo: null, voice: null, decision: "image_refused" });
  expect(resolveCompanionMedia({
    userText: "show me",
    replyText: "fine. here's another. don't get used to it.",
    canSendPhoto: false,
  })).toEqual({ photo: null, voice: null, decision: "image_refused" });
});

it("does not attach a photo just because they asked, if she called text", () => {
  expect(resolveCompanionMedia({
    toolText: true,
    userText: "show me what you're wearing",
    replyText: "later maybe.",
  })).toEqual({ photo: null, voice: null, decision: "text" });
});

it("attaches a photo if the text claims she sent one but she forgot the tool", () => {
  expect(resolveCompanionMedia({
    userText: "show me",
    replyText: "fine. here's another. don't get used to it.",
  })).toEqual({
    photo: { query: "a candid moment from my day" },
    voice: null,
    decision: "image_sent",
  });
});

it("does not drop a photo if the assistant text claims a photo even when rate limited", () => {
  expect(resolveCompanionMedia({
    userText: "give your selfie",
    replyText: "had to dig through my phone for a non-awkward one, but here you go\n\ncaught mid-refill on the caffeine",
    isRateLimited: true,
  })).toEqual({
    photo: { query: "a candid photo of me" },
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
    userText: "I wanna hear your voice",
    replyText: "sure, wrapping up at the shop.",
  })).toEqual({ photo: null, voice: null, decision: "text" });
});

it("does not attach when she called refuse_voice_note", () => {
  expect(resolveCompanionMedia({
    toolVoice: { action: "refuse", reason: "can't talk right now" },
    userText: "I wanna hear you",
    replyText: "can't talk, texting",
  })).toEqual({ photo: null, voice: null, decision: "audio_refused" });
});

it("does not attach a voice note when the user cannot afford one", () => {
  expect(resolveCompanionMedia({
    toolVoice: { action: "send", spoken: "hey, wrapping the table now" },
    replyText: "one sec",
    canSendVoice: false,
  })).toEqual({ photo: null, voice: null, decision: "audio_refused" });
});

it("does not turn a voice tool into a photo even after photo refusals", () => {
  expect(resolveCompanionMedia({
    toolVoice: { action: "send", spoken: "hey it's me" },
    forceSend: true,
    userText: "I wanna hear your voice",
    replyText: "one sec",
  })).toEqual({
    photo: null,
    voice: { spoken: "hey it's me" },
    decision: "audio_sent",
  });
});
