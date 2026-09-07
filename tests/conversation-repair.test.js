import { expect, it } from "vitest";
import { isStyleFeedback, getRepairInstruction } from "../src/services/conversation-repair.service.js";

it.each([
    "why are you so linkedin type emssages",
    "you sound like a chatbot",
    "your messages are too formal",
    "stop writing essays",
    "talk like a person",
])("recognizes tone feedback: %s", message => {
    expect(isStyleFeedback(message)).toBe(true);
    expect(getRepairInstruction(message)).toContain("then stop");
});
it.each([
    "I found a job on LinkedIn",
    "are you a professional photographer?",
    "my manager is too formal",
    "tell me about photography",
])("does not misread normal topics as style feedback: %s", message => {
    expect(isStyleFeedback(message)).toBe(false);
    expect(getRepairInstruction(message)).toBe("");
});
