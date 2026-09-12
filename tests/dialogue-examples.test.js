import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { selectDialogueExamples } from "../src/services/dialogue-examples.service.js";
import { buildCharacterPrompt } from "../src/services/context.service.js";
import { validateCharacterCatalog } from "../src/services/character-catalog.service.js";
const catalog = JSON.parse(
  await readFile(
    new URL("../data/characters.example.json", import.meta.url),
    "utf8",
  ),
);
const maya = catalog[0];

it("validates and retains structured examples through catalog import", async () => {
  const [validated] = await validateCharacterCatalog(catalog);
  expect(validated.dialogueExamples).toHaveLength(12);
  await expect(
    validateCharacterCatalog([
      { ...maya, dialogueExamples: [{ situation: "unknown", user: "hi" }] },
    ]),
  ).rejects.toThrow();
});

it.each([
  ["today was awful", "vulnerability"],
  ["i meant my sister, not my ex", "misunderstanding"],
  ["i got the job!!", "excitement"],
  ["please stop calling me pet names", "boundaries"],
  ["film photography is overrated", "disagreement"],
  ["nothing much, folding laundry", "ordinary"],
])(
  "selects an appropriate voice demonstration for %s",
  (currentMessage, situation) => {
    const examples = selectDialogueExamples(maya, { currentMessage });
    expect(examples[0].situation).toBe(situation);
    expect(examples.length).toBeLessThanOrEqual(1);
  },
);

it("does not let older exciting messages override a current boundary", () => {
  const selected = selectDialogueExamples(maya, {
    currentMessage: "please stop calling me pet names",
    history: [{ content: "i got the job!! finally passed excited" }],
  });
  expect(selected[0].situation).toBe("boundaries");
});

it("respects relationship restrictions, budgets, and absent or irrelevant examples", () => {
  const character = {
    dialogueExamples: [
      {
        situation: "greeting",
        stages: ["romantic"],
        user: "hey",
        assistant: "hello love",
      },
    ],
  };
  expect(selectDialogueExamples(character, { currentMessage: "hey" })).toEqual(
    [],
  );
  expect(
    selectDialogueExamples(character, {
      currentMessage: "hey",
      stage: "romantic",
    }),
  ).toHaveLength(1);
  expect(
    selectDialogueExamples(maya, {
      currentMessage: "today was awful",
      tokenBudget: 1,
    }),
  ).toEqual([]);
  expect(
    selectDialogueExamples(maya, {
      currentMessage: "today was awful",
      limit: 0,
    }),
  ).toEqual([]);
  expect(
    selectDialogueExamples(maya, { currentMessage: "quantum mechanics" }),
  ).toEqual([]);
  expect(selectDialogueExamples({}, { currentMessage: "hey" })).toEqual([]);
});

it("labels examples as fiction and keeps Maya's distress response brief", () => {
  const examples = selectDialogueExamples(maya, {
    currentMessage: "today was awful",
  });
  expect(examples[0].assistant).toBe("ah shit. want to talk about it?");
  const prompt = buildCharacterPrompt(maya, {}, [], "UTC", examples);
  expect(prompt).toContain("not conversation history");
  expect(prompt).toContain("Current context and boundaries take precedence");
  expect(prompt).not.toContain("home repair supplies");
});

it("uses a terse acknowledgement example instead of arbitrary lifestyle detail", () => {
  expect(
    selectDialogueExamples(maya, { currentMessage: "ok" })[0].assistant,
  ).toBe("okay");
});

it("selects a personal boundary for a new relationship without prescribing it to romantic relationships", () => {
  const currentMessage = "want to have sex with me";
  expect(
    selectDialogueExamples(maya, { currentMessage, stage: "new" })[0].assistant,
  ).toBe("no. way too soon");
  expect(
    selectDialogueExamples(maya, { currentMessage, stage: "romantic" }).some(
      (example) => example.assistant === "no. way too soon",
    ),
  ).toBe(false);
});
