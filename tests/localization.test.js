import { describe, expect, it, vi } from "vitest";
import { resolveLanguage } from "../src/utils/language.js";
import { serverText } from "../src/utils/localized-strings.js";
import {
    localizeCharacter,
    localizeRelationshipCharacter,
    profileSourceHash,
    publicCharacterProjection,
    publicCharacterSelect,
} from "../src/services/character-locale.js";
import {
    staleLanguages,
    translateCharacterProfile,
    validateTranslation,
} from "../src/services/character-translation.service.js";
import { buildCharacterPrompt, languageDirective } from "../src/services/context.service.js";
import { buildChatPushMessage } from "../src/services/push-notification.service.js";

const character = () => ({
    _id: "c1",
    name: "Maya",
    age: 27,
    occupation: "Barista",
    location: "Brooklyn, New York",
    hobbies: ["film photography", "night walks"],
    gallery: [{ url: "https://x/0.png", caption: "Sunday market" }, { url: "https://x/1.png" }],
    persona: {
        summary: "I make good coffee and bad puns.",
        personalityTraits: ["Playful", "Warm"],
        values: ["honesty"],
        boundaries: ["No pushy messages"],
    },
});
const japanese = c => ({
    occupation: "バリスタ",
    location: "ニューヨーク、ブルックリン",
    summary: "コーヒーは上手、ダジャレは下手。",
    personalityTraits: ["遊び心", "あたたかい"],
    values: ["誠実さ"],
    boundaries: ["しつこいメッセージはNG"],
    hobbies: ["フィルム写真", "夜の散歩"],
    galleryCaptions: ["日曜のマーケット", ""],
    sourceHash: profileSourceHash(c),
});

describe("resolveLanguage", () => {
    it("takes the preferred base language and falls back to English", () => {
        expect(resolveLanguage("ja")).toBe("ja");
        expect(resolveLanguage("fr-CA,fr;q=0.9,en;q=0.8")).toBe("fr");
        expect(resolveLanguage("pt-BR")).toBe("en");
        expect(resolveLanguage(undefined)).toBe("en");
    });
});

describe("localizeCharacter", () => {
    it("swaps in translated fields and never sends the translations", () => {
        const c = character();
        c.translations = { ja: japanese(c) };
        const out = localizeCharacter(c, "ja");
        expect(out.occupation).toBe("バリスタ");
        expect(out.persona.summary).toBe("コーヒーは上手、ダジャレは下手。");
        expect(out.persona.personalityTraits).toEqual(["遊び心", "あたたかい"]);
        expect(out.hobbies).toEqual(["フィルム写真", "夜の散歩"]);
        expect(out.gallery[0].caption).toBe("日曜のマーケット");
        expect(out.gallery[1].caption).toBeUndefined();
        expect(out.name).toBe("Maya");
        expect(out.translations).toBeUndefined();
    });

    it("uses English for English, a missing language, or a stale translation", () => {
        const c = character();
        c.translations = { ja: japanese(c) };
        expect(localizeCharacter(c, "en").occupation).toBe("Barista");
        expect(localizeCharacter(c, "ko").occupation).toBe("Barista");
        const edited = { ...c, persona: { ...c.persona, summary: "New bio" } };
        expect(localizeCharacter(edited, "ja").persona.summary).toBe("New bio");
        expect(localizeCharacter(edited, "ja").translations).toBeUndefined();
    });

    it("keeps English lists when the translated list does not line up", () => {
        const c = character();
        c.translations = { ja: { ...japanese(c), hobbies: ["フィルム写真"] } };
        expect(localizeCharacter(c, "ja").hobbies).toEqual(["film photography", "night walks"]);
    });

    it("localizes a populated relationship and leaves unpopulated ids alone", () => {
        const c = character();
        c.translations = { ja: japanese(c) };
        expect(localizeRelationshipCharacter({ _id: "r1", characterId: c }, "ja").characterId.occupation).toBe("バリスタ");
        expect(localizeRelationshipCharacter({ _id: "r1", characterId: "c1" }, "ja").characterId).toBe("c1");
    });

    it("selects only public fields plus the requested translation", () => {
        expect(publicCharacterSelect("ja")).toContain("translations.ja");
        expect(publicCharacterSelect("en")).not.toContain("translations");
        expect(publicCharacterSelect("xx")).not.toContain("translations");
        const projection = publicCharacterProjection("ko");
        expect(projection["translations.ko"]).toBe(1);
        expect(projection.promptTemplate).toBeUndefined();
        expect(projection.backstory).toBeUndefined();
        expect(projection.dialogueExamples).toBeUndefined();
    });
});

describe("character translation", () => {
    it("only redoes languages that are missing or stale", () => {
        const c = character();
        c.translations = { ja: japanese(c), ko: { ...japanese(c), sourceHash: "old" } };
        expect(staleLanguages(c, ["ja", "ko", "de"])).toEqual(["ko", "de"]);
        expect(staleLanguages(c, ["ja"], { force: true })).toEqual(["ja"]);
    });

    it("rejects translations that change the shape", () => {
        const c = character();
        const source = {
            occupation: "Barista", location: "Brooklyn", summary: "Hi",
            personalityTraits: ["a", "b"], values: [], boundaries: [], hobbies: [], galleryCaptions: ["x", ""],
        };
        expect(() => validateTranslation(source, { ...source, personalityTraits: ["a"] })).toThrow(/2 items/);
        expect(() => validateTranslation(source, { ...source, summary: "" })).toThrow(/summary/);
        expect(validateTranslation(source, { ...source, galleryCaptions: ["y", "junk"] }).galleryCaptions).toEqual(["y", ""]);
        expect(c).toBeTruthy();
    });

    it("retries once and stamps the source hash", async () => {
        const c = character();
        const { sourceHash: _ignored, ...good } = japanese(c);
        const llm = {
            model: "test-model",
            generateJson: vi.fn()
                .mockResolvedValueOnce({ occupation: "" })
                .mockResolvedValueOnce(good),
        };
        const result = await translateCharacterProfile({ character: c, language: "ja", llm });
        expect(llm.generateJson).toHaveBeenCalledTimes(2);
        expect(result.occupation).toBe("バリスタ");
        expect(result.sourceHash).toBe(profileSourceHash(c));
        expect(result.model).toBe("test-model");
        expect(llm.generateJson.mock.calls[0][0].messages[0].content).toContain("into Japanese");
    });
});

describe("reply language", () => {
    it("tells the companion to reply in the user's language", () => {
        const directive = languageDirective("ja").join("\n");
        expect(directive).toContain("Write every reply in Japanese");
        expect(directive).toContain("still answer in Japanese");
        expect(directive).toContain("Voice notes");
        expect(languageDirective("en").join("\n")).toContain("natural English");
        expect(languageDirective("xx").join("\n")).toContain("natural English");
    });

    it("puts the directive in the character prompt from the user profile", () => {
        const prompt = buildCharacterPrompt(character(), { stage: "new" }, [], undefined, [], { language: "de" }, []);
        expect(prompt).toContain("Write every reply in German");
        expect(prompt).not.toContain("natural English");
        const english = buildCharacterPrompt(character(), { stage: "new" }, [], undefined, [], null, []);
        expect(english).toContain("natural English");
    });
});

describe("server texts", () => {
    it("localizes fallback lines and push texts", () => {
        expect(serverText("photoFailed", "es")).toBe("no se pudo enviar la foto ahora.");
        expect(serverText("photoFailed", "pt")).toBe("couldn't get that photo through just now.");
        const push = buildChatPushMessage({ token: "t", characterName: "Maya", content: "", relationshipId: "r", extraData: { mediaType: "image" }, language: "ja" });
        expect(push.notification.body).toBe("📷 写真が届きました");
        const english = buildChatPushMessage({ token: "t", characterName: "Maya", content: "", relationshipId: "r", extraData: { mediaType: "audio" } });
        expect(english.notification.body).toBe("🎙️ Sent you a voice note");
    });
});
