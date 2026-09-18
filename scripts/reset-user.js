import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { UserModel } from "../src/models/user.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { MemoryModel } from "../src/models/memory.model.js";
import { MemoryJobModel } from "../src/models/memory-job.model.js";
import { SwipeModel } from "../src/models/swipe.model.js";

const args = process.argv.slice(2);
const shouldDeleteUser = args.includes("--delete-user");
const targetEmail = args.find((arg) => !arg.startsWith("--")) || "ayushkumarsanu00@gmail.com";

await connectDatabase(env.MONGODB_URI);

try {
    const user = await UserModel.findOne({
        email: { $regex: new RegExp(`^${targetEmail.trim()}$`, "i") },
    });

    if (!user) {
        console.error(`User with email "${targetEmail}" not found.`);
        process.exit(1);
    }

    const userId = user.userId;
    console.log(`Found user: ${user.name} (${user.email}), userId: ${userId}`);

    // 1. Find all relationships for this user
    const relationships = await RelationshipModel.find({ userId }).select("_id").lean();
    const relIds = relationships.map((r) => r._id);

    // 2. Delete messages
    const deletedMessages = relIds.length > 0
        ? await MessageModel.deleteMany({ relationshipId: { $in: relIds } })
        : { deletedCount: 0 };

    // 3. Delete memory jobs
    const deletedJobs = relIds.length > 0
        ? await MemoryJobModel.deleteMany({ relationshipId: { $in: relIds } })
        : { deletedCount: 0 };

    // 4. Delete memories
    const deletedMemories = await MemoryModel.deleteMany({
        $or: [
            { userId },
            ...(relIds.length > 0 ? [{ relationshipId: { $in: relIds } }] : []),
        ],
    });

    // 5. Delete relationships
    const deletedRelationships = await RelationshipModel.deleteMany({ userId });

    // 6. Delete swipes
    const deletedSwipes = await SwipeModel.deleteMany({ userId });

    // 7. Reset or delete user profile
    if (shouldDeleteUser) {
        await UserModel.deleteOne({ _id: user._id });
        console.log(`- User record: completely deleted from database.`);
    } else {
        await UserModel.updateOne(
            { _id: user._id },
            {
                $set: {
                    bio: "",
                    vibe: "Everyone",
                    minAge: 18,
                    maxAge: 60,
                    avatarKey: "",
                    onboardedAt: null,
                    lastDailyHeartsClaimedAt: null,
                    revenueCatEventAt: null,
                    isPremium: false,
                    premiumEntitlement: "",
                    revenueCatAppUserId: null,
                    premiumExpiresAt: null,
                },
                $unset: {
                    age: 1,
                },
            }
        );
        console.log(`- User profile fields reset to initial defaults (bio, vibe, minAge, maxAge, age, onboardedAt, premium).`);
    }

    console.log("\nReset Summary:");
    console.log(`- Messages deleted: ${deletedMessages.deletedCount}`);
    console.log(`- Relationships deleted: ${deletedRelationships.deletedCount}`);
    console.log(`- Swipes deleted: ${deletedSwipes.deletedCount}`);
    console.log(`- Memory jobs deleted: ${deletedJobs.deletedCount}`);
    console.log(`- Memories deleted: ${deletedMemories.deletedCount}`);
    console.log(`\nSuccessfully reset data for ${targetEmail}!`);
} finally {
    await disconnectDatabase();
}
