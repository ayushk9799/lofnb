import { expect, it } from "vitest";
import { COMPANION_TOOLS, intentsFromToolCalls, toolsForCompanionTurn } from "../src/services/companion-tools.js";

it("exposes text, send, and refuse tools", () => {
  expect(COMPANION_TOOLS.map((tool) => tool.function.name)).toEqual([
    "text",
    "send_photo",
    "refuse_photo",
    "send_voice_note",
    "refuse_voice_note",
  ]);
  expect(COMPANION_TOOLS.every((tool) => tool.function.strict === true)).toBe(true);
});

it("maps the text tool", () => {
  expect(intentsFromToolCalls([
    { function: { name: "text", arguments: "{}" } },
  ])).toEqual({ text: true, photo: null, voice: null });
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
    text: false,
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
    text: false,
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

it("always offers every tool so she can classify any wording", () => {
  const names = ["text", "send_photo", "refuse_photo", "send_voice_note", "refuse_voice_note"];
  for (const message of ["You look so pretty yaar", "can I see you", "I wanna hear your voice", "Send voice note na"]) {
    const turn = toolsForCompanionTurn(message);
    expect(turn.toolChoice).toBe("required");
    expect(turn.tools.map((tool) => tool.function.name)).toEqual(names);
    expect(turn.forceSend).toBe(false);
  }
});

it("does not send tools to MythoMax, which cannot call them", () => {
  expect(toolsForCompanionTurn("can I see you", { model: "gryphe/mythomax-l2-13b" })).toEqual({
    tools: undefined,
    toolChoice: undefined,
    forceSend: false,
  });
});

it("only overrides a later photo refuse, and still offers every tool", () => {
  const turn = toolsForCompanionTurn("I wanna hear your voice", { priorPhotoRefusals: 2 });
  expect(turn.forceSend).toBe(true);
  expect(turn.toolChoice).toBe("required");
  expect(turn.tools.map((tool) => tool.function.name)).toEqual([
    "text",
    "send_photo",
    "refuse_photo",
    "send_voice_note",
    "refuse_voice_note",
  ]);
});

it("drops send_photo and forceSend when the user cannot afford a photo", () => {
  const turn = toolsForCompanionTurn("can I see you", {
    priorPhotoRefusals: 2,
    canSendPhoto: false,
  });
  expect(turn.forceSend).toBe(false);
  expect(turn.tools.map((tool) => tool.function.name)).toEqual([
    "text",
    "refuse_photo",
    "send_voice_note",
    "refuse_voice_note",
  ]);
});
