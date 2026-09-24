import { expect, it } from "vitest";
import { conversationUpdateSchema, reduceConversationState, conversationContext } from "../src/services/conversation-state.service.js";
import { createReplyBubbles } from "../src/services/reply-bubbles.service.js";

const user = {_id: "u1", content: "I like talking to you. Let's keep it friendly."};
const assistant = {_id: "a1", content: "I like talking to you too. I'm making pasta tonight.", sequenceNumber: 4};
const now = new Date("2026-09-23T18:00:00Z");
const reduce = (previous, update, sources = {}) => reduceConversationState(previous, conversationUpdateSchema.parse(update), {user, assistant, now, ...sources});

it("requires source evidence and never derives familiarity from assistant enthusiasm alone", () => {
    expect(reduce({}, {familiarity: "familiar", userEvidence: "made up"})).toEqual({});
    const next = reduce({}, {familiarity: "familiar", trust: "established", assistantEvidence: "I like talking to you too."});
    expect(next.familiarity).toBeUndefined();
    expect(next.trust).toBeUndefined();
});

it("develops familiarity gradually from evidence and applies a no-flirting preference immediately", () => {
    const next = reduce({}, {familiarity: "familiar", trust: "established", romanticComfort: "declined", commitment: "friends", userEvidence: user.content});
    expect(next).toMatchObject({familiarity: "getting_familiar", trust: "developing", romanticComfort: "declined", commitment: "friends", sequence: 4});
    expect(next.sourceMessageIds).toEqual(["u1"]);
});

it("does not turn unilateral interest into commitment", () => {
    expect(reduce({}, {commitment: "partners", mutualAgreement: true, userEvidence: user.content}).commitment).toBeUndefined();
    const next = reduce({}, {commitment: "partners", mutualAgreement: true, userEvidence: "Let's be partners.", assistantEvidence: "Yes, let's be partners."}, {
        user: {...user, content: "Let's be partners."}, assistant: {...assistant, content: "Yes, let's be partners."},
    });
    expect(next.commitment).toBe("partners");
});

it("does not rewind newer state or replay a completed update", () => {
    const previous = {sequence: 4, activeThread: "new topic"};
    expect(reduce(previous, {activeThread: "old topic", userEvidence: user.content})).toBe(previous);
    expect(reduce({...previous, sequence: 7}, {activeThread: "old topic", userEvidence: user.content})).toEqual({...previous, sequence: 7});
});

it("records only communicated scenes and expires present-tense events without inventing an outcome", () => {
    const next = reduce({}, {assistantEvidence: assistant.content, scene: {description: "Making pasta tonight", status: "active", evidence: "I'm making pasta tonight."}}, {user: null});
    expect(next.scene.sourceMessageId).toBe("a1");
    expect(conversationContext(next, new Date("2026-09-25T18:00:00Z")).scene.status).toBe("past; outcome unknown");
    const repeated = reduce(next, {assistantEvidence: assistant.content, scene: {description: "Making pasta tonight", status: "active", evidence: "I'm making pasta tonight."}}, {assistant: {...assistant, sequenceNumber: 6}, now: new Date("2026-09-24T18:00:00Z")});
    expect(repeated.scene.expiresAt).toEqual(next.scene.expiresAt);
    expect(reduce({}, {assistantEvidence: assistant.content, scene: {description: "Bought a house", status: "active", evidence: "I bought a house"}}).scene).toBeUndefined();
});

it("keeps authored paragraphs stable and limits bubbles without dropping content", () => {
    const bubbles = createReplyBubbles("hey :)\r\n\r\nthat sounds fun. really fun!\n\nthird\n\nfourth\n\nfifth", "a1");
    expect(bubbles.map(b => b.text)).toEqual(["hey :)", "that sounds fun. really fun!", "third", "fourth\n\nfifth"]);
    expect(bubbles.map(b => b.id)).toEqual(["a1:0", "a1:1", "a1:2", "a1:3"]);
    expect(createReplyBubbles("  ", "a1")).toEqual([]);
    expect(createReplyBubbles("```js\nconst x = 1;\n\nconsole.log(x);\n```", "a1")).toHaveLength(1);
});
