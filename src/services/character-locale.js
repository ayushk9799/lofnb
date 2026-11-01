import crypto from "node:crypto";
import { TRANSLATION_LANGUAGES } from "../utils/language.js";

// Profile fields the apps show. Prompts, backstory and examples stay private.
export const PUBLIC_CHARACTER_FIELDS = [
    "slug", "name", "age", "gender", "avatarUrl", "photos", "gallery", "ethnicity", "occupation", "location", "hobbies",
    "persona.summary", "persona.personalityTraits", "persona.values", "persona.boundaries",
];

/** Projection (select string) for public fields plus one language's translation. */
export function publicCharacterSelect(language) {
    const fields = [...PUBLIC_CHARACTER_FIELDS];
    if (TRANSLATION_LANGUAGES.includes(language)) fields.push(`translations.${language}`);
    return fields.join(" ");
}

/** The same projection as an aggregation $project object. */
export function publicCharacterProjection(language) {
    return Object.fromEntries(publicCharacterSelect(language).split(" ").map(field => [field, 1]));
}

/** The English text a translation is made from. */
export function translatableProfile(character) {
    return {
        occupation: character?.occupation || "",
        location: character?.location || "",
        summary: character?.persona?.summary || "",
        personalityTraits: character?.persona?.personalityTraits || [],
        values: character?.persona?.values || [],
        boundaries: character?.persona?.boundaries || [],
        hobbies: character?.hobbies || [],
        galleryCaptions: (character?.gallery || []).map(photo => photo?.caption || ""),
    };
}

export function profileSourceHash(character) {
    return crypto.createHash("sha256").update(JSON.stringify(translatableProfile(character))).digest("hex").slice(0, 32);
}

// A translated list replaces the English one only when the items line up.
function sameLength(translated, english) {
    return Array.isArray(translated) && translated.length === english.length ? translated : english;
}
function text(translated, english) {
    return typeof translated === "string" && translated.trim() && english ? translated : english;
}

/**
 * Swap in the translated profile fields for `language`. English, a missing
 * translation, or one made from older English text all fall back to English.
 * The translations themselves are never sent to clients.
 */
export function localizeCharacter(character, language) {
    if (!character || typeof character !== "object") return character;
    const { translations, ...rest } = character;
    const translated = translations?.[language];
    if (!translated || translated.sourceHash !== profileSourceHash(character)) return rest;
    const english = translatableProfile(character);
    const captions = sameLength(translated.galleryCaptions, english.galleryCaptions);
    return {
        ...rest,
        occupation: text(translated.occupation, rest.occupation),
        location: text(translated.location, rest.location),
        hobbies: rest.hobbies ? sameLength(translated.hobbies, english.hobbies) : rest.hobbies,
        ...(rest.gallery ? {
            gallery: rest.gallery.map((photo, index) => (
                photo?.caption ? { ...photo, caption: text(captions[index], photo.caption) } : photo
            )),
        } : {}),
        ...(rest.persona ? {
            persona: {
                ...rest.persona,
                summary: text(translated.summary, rest.persona.summary),
                personalityTraits: sameLength(translated.personalityTraits, english.personalityTraits),
                values: sameLength(translated.values, english.values),
                boundaries: sameLength(translated.boundaries, english.boundaries),
            },
        } : {}),
    };
}

/** Localize the populated character of a relationship row. */
export function localizeRelationshipCharacter(relationship, language) {
    if (!relationship?.characterId || typeof relationship.characterId !== "object" || !relationship.characterId.name) {
        return relationship;
    }
    return { ...relationship, characterId: localizeCharacter(relationship.characterId, language) };
}
