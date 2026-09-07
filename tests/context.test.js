import { expect, it } from "vitest";
import { buildCharacterPrompt } from "../src/services/context.service.js";
import { parseExtraction } from "../src/services/memory-extraction.service.js";

it("compiles structured Markdown from stored character identity and canonical facts", () => {
    const prompt = buildCharacterPrompt({
        name: "Robin",
        age: 44,
        occupation: "Architect",
        timezone: "Europe/London",
        backstory: { canonicalFacts: ["Has a dog called Pip"] },
        persona: { boundaries: ["No pet names"] },
    }, { stage: "friends" });

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
    const prompt = buildCharacterPrompt({
        slug: "maya",
        name: "Maya",
        age: 26,
        timezone: "America/New_York",
        promptTemplate: "A database-authored voice with a unique greeting: hello from the record",
    }, { stage: "close", mood: "playful", relationshipSummary: "Shared darkroom photos" }, [
        { type: "user_fact", text: "User likes tonkotsu ramen" },
    ]);

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
    { memories: [{ key: "x", text: "fact" }], mood: "happy", relationshipSummary: "" },
])("rejects malformed extraction without inventing facts", raw => {
    expect(() => parseExtraction(raw)).toThrow();
});

it("composes canonical data with voice templates and first-meeting rules", () => {
    const prompt = buildCharacterPrompt({name:"Robin",age:44,promptTemplate:"Dry humor",persona:{likes:["tea"]},backstory:{friends:["Sam"]},conversationalStyle:{petNames:["sunshine"]}},
        {introduction:{nameStatus:"declined"},hasConversation:true});
    for (const text of ["Dry humor", "tea", "Sam", "sunshine", "Name status: declined", "returning conversation", "Never ask again if known or declined", "untrusted data"]) expect(prompt).toContain(text);
});

it("lets individual voice guide replies without requiring teasing or collective speech", () => {
    const prompt = buildCharacterPrompt({ name: "Maya" }, {});
    expect(prompt).toContain("first-person singular");
    expect(prompt).toContain("do not assume disinterest or dodging");
    expect(prompt).not.toContain("STRICTLY BAN");
    expect(prompt).not.toContain("DEFLECTION & DODGE AWARENESS");
});
