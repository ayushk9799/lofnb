import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CharacterModel } from "../src/models/character.model.js";

const GENDER_MAP = {
    maya: "female",
    elena: "female",
    kai: "male",
    zara: "female",
    liam: "male",
    aria: "female",
    mateo: "male",
    chloe: "female",
    marcus: "male",
    sora: "female",
};

async function rectifyCharacterGenders() {
    console.log("[Rectify] Connecting to database...");
    await connectDatabase(env.MONGODB_URI);

    try {
        const characters = await CharacterModel.find({}).lean();
        console.log(`[Rectify] Found ${characters.length} total character records in database.`);

        let updatedCount = 0;
        let unchangedCount = 0;

        for (const char of characters) {
            const targetGender = GENDER_MAP[char.slug] || (char.gender && ["female", "male"].includes(char.gender) ? char.gender : "female");

            if (char.gender !== targetGender) {
                await CharacterModel.updateOne(
                    { _id: char._id },
                    { $set: { gender: targetGender } }
                );
                console.log(`  -> Updated "${char.name}" (${char.slug}): gender set to "${targetGender}"`);
                updatedCount++;
            } else {
                unchangedCount++;
            }
        }

        console.log(`\n[Rectify] Complete: ${updatedCount} character(s) updated, ${unchangedCount} character(s) already correct.`);
    } finally {
        await disconnectDatabase();
    }
}

await rectifyCharacterGenders();
