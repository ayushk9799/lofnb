import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { MemoryModel } from "../src/models/memory.model.js";
import { MemoryJobModel } from "../src/models/memory-job.model.js";
import { UserModel } from "../src/models/user.model.js";

await connectDatabase(env.MONGODB_URI);
try {
    const mockFilter = {
        $or: [
            { userId: { $regex: /^(google_dev_|apple_dev_|mock_|lofn-mobile-dev)/ } },
            { email: { $regex: /^(dev_|mock_)/ } },
            { name: { $regex: /^User dev_/ } },
        ]
    };
    const [deletedMemories, deletedMessages, deletedRelationships, deletedJobs, deletedUsers] = await Promise.all([
        MemoryModel.deleteMany({}),
        MessageModel.deleteMany({}),
        RelationshipModel.deleteMany({}),
        MemoryJobModel.deleteMany({}),
        UserModel.deleteMany(mockFilter),
    ]);

    console.log("Database cleanup successful:");
    console.log(`- Memories removed: ${deletedMemories.deletedCount}`);
    console.log(`- Messages removed: ${deletedMessages.deletedCount}`);
    console.log(`- Relationships removed: ${deletedRelationships.deletedCount}`);
    console.log(`- Memory jobs removed: ${deletedJobs.deletedCount}`);
    console.log(`- Mock users removed: ${deletedUsers.deletedCount}`);
    console.log("Character definitions preserved.");
} finally {
    await disconnectDatabase();
}
