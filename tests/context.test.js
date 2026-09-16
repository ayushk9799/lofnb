import { expect, it } from "vitest";
import {
  buildCharacterPrompt,
  isRelevantPastContext,
  selectRelevantCharacterLore,
} from "../src/services/context.service.js";
import { parseExtraction } from "../src/services/memory-extraction.service.js";

it("compiles structured Markdown from stored character identity and canonical facts", () => {
  const character = {
    name: "Robin",
    age: 44,
    occupation: "Architect",
    timezone: "Europe/London",
    backstory: { canonicalFacts: ["Has a dog called Pip"] },
    persona: { boundaries: ["No pet names"] },
  };
  const relevantLore = selectRelevantCharacterLore(
    character,
    "do you have a dog?",
  );
  const prompt = buildCharacterPrompt(
    character,
    { stage: "friends" },
    [],
    undefined,
    [],
    null,
    relevantLore,
  );

  expect(prompt).toContain("# Character: Robin");
  expect(prompt).toContain("age 44");
  expect(prompt).toContain("Architect");
  expect(prompt).toContain("Has a dog called Pip");
  expect(prompt).toContain("No pet names");
  expect(prompt).not.toContain("Brooklyn");
  expect(prompt).not.toContain('{"name":"Robin"');
  expect(prompt).not.toContain("26-year-old");
  expect(prompt).not.toContain("20-something");
  expect(prompt).not.toContain("darkrooms");
  expect(prompt).not.toContain("ramen");
  expect(prompt).not.toContain("sound design");
});

it("uses database voice instructions independently of the character slug", () => {
  const prompt = buildCharacterPrompt(
    {
      slug: "maya",
      name: "Maya",
      age: 26,
      timezone: "America/New_York",
      promptTemplate:
        "A database-authored voice with a unique greeting: hello from the record",
    },
    {
      stage: "close",
      mood: "playful",
      relationshipSummary: "Shared darkroom photos",
    },
    [{ type: "user_fact", text: "User likes tonkotsu ramen" }],
  );

  expect(prompt).toContain("hello from the record");
  expect(prompt).not.toContain("Maya Takahashi");
  expect(prompt).toContain("User likes tonkotsu ramen");
  expect(prompt).toContain("America/New_York");
  expect(prompt).toContain("Stage: close (Mood: playful)");
});

it.each([
  null,
  { memories: [null] },
  { memories: [], mood: 12 },
  {
    memories: [{ key: "x", text: "fact" }],
    mood: "happy",
    relationshipSummary: "",
  },
])("rejects malformed extraction without inventing facts", (raw) => {
  expect(() => parseExtraction(raw)).toThrow();
});

it("keeps unrelated profile decoration out while retaining voice and relationship state", () => {
  const prompt = buildCharacterPrompt(
    {
      name: "Robin",
      age: 44,
      promptTemplate: "Dry humor",
      persona: { likes: ["oolong tea"] },
      backstory: { friends: ["Sam"] },
      conversationalStyle: { petNames: ["sunshine"] },
    },
    { introduction: { nameStatus: "declined" }, hasConversation: true },
  );
  for (const text of [
    "Dry humor",
    "Name status: declined",
    "returning conversation",
    "untrusted data",
  ])
    expect(prompt).toContain(text);
  for (const text of ["oolong tea", "Sam", "sunshine", "Introduction Directive"])
    expect(prompt).not.toContain(text);
});

it("requires direct short replies without profile performance", () => {
  const prompt = buildCharacterPrompt({ name: "Maya" }, {});
  expect(prompt).toContain("one text bubble of 3–35 words");
  expect(prompt).toContain("Do not perform your profile");
  expect(prompt).toContain("Asking their name is optional");
  expect(prompt).toContain("send_photo");
  expect(prompt).toContain("refuse_photo");
  expect(prompt).toContain("send_voice_note");
  expect(prompt).toContain("refuse_voice_note");
  expect(prompt).toContain("Every reply is exactly one of");
  expect(prompt).toContain("you must call send_photo or refuse_photo");
  expect(prompt).toContain("A compliment on a photo you already sent is text only");
  expect(prompt).not.toContain("STRICTLY BAN");
  expect(prompt).not.toContain("DEFLECTION & DODGE AWARENESS");
});

it("injects older context only when the current topic connects to it", () => {
  const summary =
    "The user adopted a dog called Pepper and was nervous about its first vet visit.";
  expect(isRelevantPastContext(summary, "ok")).toBe(false);
  expect(
    isRelevantPastContext(summary, "Pepper has another vet visit tomorrow"),
  ).toBe(true);
  expect(isRelevantPastContext(summary, "what do you remember about me?")).toBe(
    true,
  );
});
