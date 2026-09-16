import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { MemoryModel } from "../src/models/memory.model.js";
import { MemoryJobModel } from "../src/models/memory-job.model.js";
import { UserModel } from "../src/models/user.model.js";
import { SwipeModel } from "../src/models/swipe.model.js";
// Creates declared indexes only. Never drops collections, records, or existing indexes.
await connectDatabase(env.MONGODB_URI);
try {
    for (const model of [CharacterModel, RelationshipModel, SwipeModel, MessageModel, MemoryModel, MemoryJobModel, UserModel]) {
        if (process.argv.includes("--apply")) await model.createIndexes();
        const actual = await model.collection.indexes().catch(error => {
            if (error.code === 26) return [];
            throw error;
        });
        console.log(JSON.stringify({model:model.modelName, declared:model.schema.indexes(), actual}));
    }
} finally { await disconnectDatabase(); }
