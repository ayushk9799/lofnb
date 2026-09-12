import mongoose from "mongoose";
import { CharacterModel } from "../models/character.model.js";

const fields = new Set([
    "slug", "name", "age", "timezone", "promptTemplate", "dialogueExamples", "avatarUrl", "ethnicity",
    "occupation", "location", "gallery", "photos", "persona", "conversationalStyle", "backstory", "hobbies", "version",
]);

// Character content is data: never execute uploaded definitions or look up files by slug.
export async function validateCharacterCatalog(records) {
    if (!Array.isArray(records) || records.length < 1 || records.length > 1000) {
        throw new Error("Provide a JSON array of 1–1000 character records per batch");
    }
    const slugs = new Set();
    const validated = [];
    for (const [index, record] of records.entries()) {
        try {
            if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Expected a character object");
            for (const key of Object.keys(record)) {
                if (!fields.has(key)) throw new Error(`Unsupported field: ${key}`);
            }
            const character = new CharacterModel(record, undefined, {strict: "throw"});
            await character.validate();
            if (slugs.has(character.slug)) throw new Error(`Duplicate slug: ${character.slug}`);
            slugs.add(character.slug);
            const value = character.toObject();
            delete value._id;
            validated.push(value);
        } catch (error) {
            throw new Error(`Character ${index + 1}: ${error.message}`, {cause: error});
        }
    }
    return validated;
}

export async function importCharacterCatalog(records, {update = false, fillMissingPrompts = false} = {}) {
    // Validate the whole batch before writes; retain IDs referenced by existing relationships.
    const values = await validateCharacterCatalog(records);
    return mongoose.connection.transaction(async session => {
        const result = await CharacterModel.bulkWrite(values.map(value => ({updateOne: {
            filter: {slug: value.slug}, update: {[update ? "$set" : "$setOnInsert"]: value}, upsert: true,
        }})), {session});
        // Backfill only missing voice instructions for old installations, never authored prompts.
        if (fillMissingPrompts) {
            const prompts = values.filter(value => value.promptTemplate).map(value => ({updateOne: {
                filter: {slug: value.slug, $or: [{promptTemplate: {$exists: false}}, {promptTemplate: ""}, {promptTemplate: null}]},
                update: {$set: {promptTemplate: value.promptTemplate}},
            }}));
            const examples = values.filter(value => value.dialogueExamples?.length).map(value => ({updateOne: {
                filter: {slug: value.slug, $or: [{dialogueExamples: {$exists: false}}, {dialogueExamples: {$size: 0}}, {dialogueExamples: null}]},
                update: {$set: {dialogueExamples: value.dialogueExamples}},
            }}));
            if (examples.length) await CharacterModel.bulkWrite(examples, {session});
            if (prompts.length) await CharacterModel.bulkWrite(prompts, {session});
        }
        return {inserted: result.upsertedCount, updated: result.modifiedCount, total: values.length};
    });
}
