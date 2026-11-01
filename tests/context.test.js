import { expect, it } from "vitest";
import {
  buildCharacterPrompt,
  conversationPhase,
  initiatingDirective,
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
  expect(prompt).toContain("Legacy relationship label: close");
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
    "You have been talking",
    "untrusted data",
  ])
    expect(prompt).toContain(text);
  for (const text of ["oolong tea", "Sam", "sunshine", "Introduction Directive"])
    expect(prompt).not.toContain(text);
});

it("omits media tools when the companion is initiating", () => {
  const prompt = buildCharacterPrompt({ name: "Maya" }, {}, [], undefined, [], null, [], true);
  expect(prompt).not.toContain("## Media");
  expect(prompt).not.toContain("send_photo");
});

it("supports first contact independently of optional profile context", () => {
  const prompt = buildCharacterPrompt(
    { name: "Maya" },
    {},
    [],
    undefined,
    [],
    { name: "Sam", bio: "I build apps and cook badly", avatarUrl: "https://r2.lofnchat.com/a.jpg" },
  );
  const remembered = buildCharacterPrompt(
    { name: "Maya" },
    { profileMemory: { photoNote: "A man in a dark jacket, smiling, indoors.", bio: "I build apps and cook badly" } },
    [],
    undefined,
    [],
    { name: "Sam", bio: "I build apps and cook badly", avatarUrl: "https://r2.lofnchat.com/a.jpg" },
  );
  expect(prompt).toContain("establish contact naturally");
  expect(prompt).toContain("one easy opening is optional");
  expect(prompt).toContain("I build apps and cook badly");
  expect(prompt).toContain("you have no note on it");
  expect(prompt).not.toContain("His profile photo is attached");
  expect(remembered).toContain("A man in a dark jacket, smiling, indoors.");
  expect(remembered).toContain("only when it fits");
  expect(prompt).not.toContain("That reply has no question");
  expect(prompt).not.toContain("Never a question about his day, week, evening");
  expect(prompt).not.toContain("one text bubble of 3–35 words");
  const empty = buildCharacterPrompt({ name: "Maya" }, {});
  expect(empty).toContain("They have no profile photo");
  expect(empty).toContain("Their profile has no bio");
  expect(empty).toContain("Do not mention a photo");
  expect(prompt).toContain("Any wording counts");
  expect(prompt).toContain("send_photo");
  expect(prompt).toContain("refuse_photo");
  expect(prompt).toContain("send_voice_note");
  expect(prompt).toContain("refuse_voice_note");
  expect(prompt).toContain("ordinary chat or a compliment");
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


it("keeps unanswered assistant messages from establishing familiarity", () => {
  const history = [{role: "assistant", content: "hey"}];
  expect(conversationPhase({history})).toBe("first_contact");
  expect(conversationPhase({history, currentMessage: "hi"})).toBe("early_exchange");
  expect(conversationPhase({history: [...history, {role: "user", content: "hi"}]})).toBe("early_exchange");
  expect(conversationPhase({history, relationship: {conversationState: {familiarity: "getting_familiar"}}})).toBe("ongoing");
  expect(conversationPhase({history, initiating: true, triggerType: "return_to_chat", relationship: {conversationState: {familiarity: "familiar"}}})).toBe("returning");
});

it("makes opener context take precedence over biography and media", () => {
  const directive = initiatingDirective("opener");
  expect(directive).toContain("two strangers");
  expect(directive).toContain("empty profile");
  expect(directive).toContain("Do not attach unsolicited photos");
  expect(directive).toContain("including paraphrases");
  const prompt = buildCharacterPrompt({name: "Freja"});
  expect(prompt).toContain("Profile knowledge is not conversation history");
  expect(prompt).toContain("Familiarity, trust, romantic comfort and commitment are independent");
  expect(prompt).not.toContain("Warmth, attraction, and flirtation are present right from the start");
});
