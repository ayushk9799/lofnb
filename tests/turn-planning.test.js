import { expect, it } from "vitest";
import {
  fallbackTurnPlan,
  normalizeTurnPlan,
  mediaOpportunity,
  turnPlanDirective,
} from "../src/services/turn-planning.service.js";
import { parseExtraction } from "../src/services/memory-extraction.service.js";
import {
  temporaryPlanTiming,
  groundedDossierMetadata,
} from "../src/services/dossier.service.js";
import { toolsForCompanionTurn } from "../src/services/companion-tools.js";
const base = {
  topic: "detective guessing game",
  engagement: "uncertain",
  move: "continue",
  reason: "Recent topic",
  media: "text",
};

it("closes the actual refused Maya topic immediately even if planning fails", () => {
  const plan = fallbackTurnPlan({
    previous: { topic: base.topic },
    currentMessage: "I don’t want to talk about this darling",
  });
  expect(plan.move).toBe("pivot");
  expect(plan.closedTopics).toEqual([
    { topic: base.topic, evidence: "I don’t want to talk about this darling" },
  ]);
  expect(plan.wantsSpace).toBe(false);
});
it("does not mistake one yeah or a short enthusiastic response for boredom", () => {
  expect(fallbackTurnPlan({ currentMessage: "Yeah" }).engagement).toBe(
    "uncertain",
  );
  expect(
    normalizeTurnPlan(
      { ...base, engagement: "engaged" },
      { currentMessage: "yes!!" },
    ).engagement,
  ).toBe("engaged");
});
it("requires current user evidence to close/reopen a topic and cannot reopen through initiation", () => {
  const previous = { closedTopics: [{ topic: base.topic, evidence: "stop" }] };
  const raw = {
    ...base,
    reopenedTopic: base.topic,
    reopenEvidence: "let's discuss it",
  };
  expect(
    normalizeTurnPlan(raw, { previous, currentMessage: "hi" }).closedTopics,
  ).toHaveLength(1);
  expect(
    normalizeTurnPlan(raw, { previous, currentMessage: "let's discuss it" })
      .closedTopics,
  ).toHaveLength(0);
  expect(
    normalizeTurnPlan(raw, {
      previous,
      currentMessage: "let's discuss it",
      initiating: true,
    }).move,
  ).toBe("wait");
  expect(
    normalizeTurnPlan({
      ...base,
      declinedTopic: base.topic,
      declineEvidence: "not present",
    }).closedTopics,
  ).toEqual([]);
});
it("offers fresh media on a fading thread, but not immediately after refusal, distress, or goodbye", () => {
  const raw = {
    ...base,
    engagement: "fading",
    move: "pivot",
    opening: "fresh saved street photo",
    media: "image",
    mediaReason: "A visual new opening",
  };
  expect(normalizeTurnPlan(raw, { media: { image: true } }).media).toBe(
    "image",
  );
  expect(
    normalizeTurnPlan({ ...raw, move: "support" }, { media: { image: true } })
      .media,
  ).toBe("text");
  expect(
    normalizeTurnPlan(
      { ...raw, declinedTopic: base.topic, declineEvidence: "stop" },
      { currentMessage: "stop", media: { image: true } },
    ).media,
  ).toBe("text");
  expect(fallbackTurnPlan({ currentMessage: "goodnight" }).move).toBe("close");
  expect(
    fallbackTurnPlan({ previous: { wantsSpace: true }, initiating: true }).move,
  ).toBe("wait");
  expect(
    fallbackTurnPlan({
      previous: { wantsSpace: true },
      currentMessage: "hey again",
    }).wantsSpace,
  ).toBe(false);
});
it("allows proactive photos and voice notes immediately after either media type", () => {
  for (const mediaType of ["image", "audio"]) {
    const history = [{ role: "assistant", mediaType, createdAt: new Date() }];
    expect(mediaOpportunity(history, { image: true, audio: true })).toEqual({
      text: true, image: true, audio: true,
    });
  }
});
it("keeps unavailable media disabled without imposing a cooldown", () => {
  expect(mediaOpportunity([], { image: false, audio: true })).toEqual({
    text: true, image: false, audio: true,
  });
  expect(mediaOpportunity([], {})).toEqual({
    text: true, image: false, audio: false,
  });
});
it("forces the selected proactive attachment tool while respecting available tools", () => {
  expect(
    toolsForCompanionTurn("yeah", { model: "test", plannedMedia: "image" })
      .toolChoice.function.name,
  ).toBe("send_photo");
  expect(
    toolsForCompanionTurn("yeah", { model: "test", plannedMedia: "audio" })
      .toolChoice.function.name,
  ).toBe("send_voice_note");
  expect(
    toolsForCompanionTurn("yeah", {
      model: "test",
      plannedMedia: "image",
      canSendPhoto: false,
    }).toolChoice,
  ).toBe("required");
  expect(turnPlanDirective({ ...base, media: "audio" })).toContain(
    "spontaneous short voice note",
  );
});
it("keeps valid facts when an optional scene lacks evidence", () => {
  const result = parseExtraction({
    mood: "neutral",
    memories: [
      {
        type: "preference",
        key: "movies",
        text: "Likes movies",
        confidence: 0.9,
        importance: 0.7,
      },
    ],
    conversationUpdate: {
      activeThread: "new subject",
      userEvidence: "new subject",
      scene: { description: "Made dinner", status: "active" },
    },
  });
  expect(result.memories).toHaveLength(1);
  expect(result.conversationUpdate.activeThread).toBe("new subject");
  expect(result.conversationUpdate.scene).toBeUndefined();
});
it("dates tonight in the user's timezone and expires at local midnight", () => {
  const occurred = new Date("2026-10-02T13:01:22Z");
  expect(
    temporaryPlanTiming(
      "Going to the theatre tonight",
      occurred,
      "Asia/Kolkata",
    ),
  ).toEqual({
    text: "Going to the theatre on 2026-10-02",
    expiresAt: new Date("2026-10-02T18:30:00Z"),
  });
  const value = {
    type: "user_fact",
    dossierCategory: "current_life",
    text: "Going to the theatre tonight",
    evidence: "theatre",
    expiresAt: "2026-10-09T13:01:22Z",
  };
  expect(
    groundedDossierMetadata(
      value,
      { content: "theatre" },
      occurred,
      "Asia/Kolkata",
    ).expiresAt,
  ).toEqual(new Date("2026-10-02T18:30Z"));
  expect(
    temporaryPlanTiming(
      "Lunch tomorrow",
      new Date("2026-03-07T20:00Z"),
      "America/New_York",
    ).expiresAt,
  ).toEqual(new Date("2026-03-09T04:00Z"));
});
