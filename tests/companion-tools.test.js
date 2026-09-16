import { expect, it } from "vitest";
import { COMPANION_TOOLS, intentsFromToolCalls, toolsForCompanionTurn } from "../src/services/companion-tools.js";

it("exposes send and refuse tools for photo and voice", () => {
  expect(COMPANION_TOOLS.map((tool) => tool.function.name)).toEqual([
    "send_photo",
    "refuse_photo",
    "send_voice_note",
    "refuse_voice_note",
  ]);
  expect(COMPANION_TOOLS.every((tool) => tool.function.strict === true)).toBe(true);
});

it("maps send_photo to a send action", () => {
  expect(intentsFromToolCalls([
    {
      function: {
        name: "send_photo",
        arguments: JSON.stringify({ what: "brooklyn park at golden hour" }),
      },
    },
  ])).toEqual({
    photo: { action: "send", query: "brooklyn park at golden hour" },
    voice: null,
  });
});

it("maps refuse_photo to a refuse action", () => {
  expect(intentsFromToolCalls([
    {
      function: {
        name: "refuse_photo",
        arguments: JSON.stringify({ reason: "don't send pics to strangers" }),
      },
    },
  ])).toEqual({
    photo: { action: "refuse", reason: "don't send pics to strangers" },
    voice: null,
  });
});

it("keeps send_photo when both send and refuse are called", () => {
  expect(intentsFromToolCalls([
    {
      function: {
        name: "refuse_photo",
        arguments: JSON.stringify({ reason: "maybe later" }),
      },
    },
    {
      function: {
        name: "send_photo",
        arguments: JSON.stringify({ what: "stoop at dusk" }),
      },
    },
  ]).photo).toEqual({ action: "send", query: "stoop at dusk" });
});

it("maps a voice tool call to spoken text", () => {
  expect(intentsFromToolCalls([
    { function: { name: "send_voice_note", arguments: '{"spoken":"hey I just got in, the train was late"}' } },
  ]).voice).toEqual({ action: "send", spoken: "hey I just got in, the train was late" });
});

it("maps refuse_voice_note to a refuse action", () => {
  expect(intentsFromToolCalls([
    {
      function: {
        name: "refuse_voice_note",
        arguments: JSON.stringify({ reason: "can't talk right now" }),
      },
    },
  ]).voice).toEqual({ action: "refuse", reason: "can't talk right now" });
});

it("requires a send or refuse tool when they asked for a photo", () => {
  const turn = toolsForCompanionTurn("Send pic na");
  expect(turn.photoNeeded).toBe(true);
  expect(turn.toolChoice).toBe("required");
  expect(turn.tools.map((tool) => tool.function.name)).toEqual(["send_photo", "refuse_photo"]);
});

it("does not offer media tools when only text is needed", () => {
  expect(toolsForCompanionTurn("You look so pretty yaar")).toEqual({
    tools: undefined,
    toolChoice: undefined,
    photoNeeded: false,
    voiceNeeded: false,
  });
});

it("requires a send or refuse tool when they asked for a voice note", () => {
  const turn = toolsForCompanionTurn("send a voice note");
  expect(turn.voiceNeeded).toBe(true);
  expect(turn.toolChoice).toBe("required");
  expect(turn.tools.map((tool) => tool.function.name)).toEqual([
    "send_voice_note",
    "refuse_voice_note",
  ]);
});
