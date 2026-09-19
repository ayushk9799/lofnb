import { Schema, model } from "mongoose";
const characterSchema = new Schema({
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    age: { type: Number, required: true, min: 18, max: 120 },
    gender: { type: String, enum: ["female", "male"], required: true, default: "female", index: true },
    timezone: { type: String, default: "UTC", validate: value => { try { new Intl.DateTimeFormat("en", {timeZone: value}); return true; } catch { return false; } } },
    promptTemplate: { type: String, maxlength: 16000 },
    dialogueExamples: {
        type: [new Schema({
            situation: { type: String, required: true, enum: ["greeting", "disagreement", "misunderstanding", "excitement", "vulnerability", "boundaries", "ordinary"] },
            keywords: [{ type: String, trim: true, maxlength: 80 }],
            stages: [{ type: String, enum: ["new", "friends", "close", "romantic"] }],
            user: { type: String, required: true, trim: true, maxlength: 1200 },
            assistant: { type: String, required: true, trim: true, maxlength: 1200 },
        }, { _id: false })],
        default: undefined,
        validate: value => !value || value.length <= 30,
    },
    avatarUrl: { type: String, trim: true },
    ethnicity: { type: String, trim: true, maxlength: 120 },
    occupation: { type: String, trim: true, maxlength: 160 },
    location: { type: String, trim: true, maxlength: 160 },
    gallery: [
        {
            url: { type: String, required: true, trim: true },
            caption: { type: String, trim: true, maxlength: 240 },
        },
    ],
    photos: [{ type: String, trim: true }],
    persona: {
        summary: { type: String, required: true, maxlength: 4_000 },
        personalityTraits: [{ type: String, maxlength: 80 }],
        values: [{ type: String, maxlength: 120 }],
        likes: [{ type: String, maxlength: 120 }],
        dislikes: [{ type: String, maxlength: 120 }],
        boundaries: [{ type: String, maxlength: 200 }],
    },
    conversationalStyle: {
        messageLength: {
            type: String,
            enum: ["short", "balanced", "detailed"],
            default: "balanced",
        },
        emojiUsage: {
            type: String,
            enum: ["none", "light", "frequent"],
            default: "light",
        },
        capitalization: {
            type: String,
            enum: ["standard", "lowercase", "expressive"],
            default: "standard",
        },
        slang: [{ type: String, maxlength: 80 }],
        petNames: [{ type: String, maxlength: 80 }],
    },
    backstory: {
        summary: { type: String, required: true, maxlength: 8_000 },
        friends: [{ type: String, maxlength: 200 }],
        importantEvents: [{ type: String, maxlength: 400 }],
        canonicalFacts: [{ type: String, maxlength: 400 }],
        pastRelationships: { type: String, maxlength: 1_000 },
    },
    hobbies: [{ type: String, maxlength: 100 }],
    matchProbability: { type: Number, min: 0, max: 1 },
    version: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true });
export const CharacterModel = model("Character", characterSchema);
