import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { UserModel } from "../src/models/user.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { MemoryModel } from "../src/models/memory.model.js";
import { MemoryJobModel } from "../src/models/memory-job.model.js";
import { SwipeModel } from "../src/models/swipe.model.js";
import { SubscriptionTransactionModel } from "../src/models/subscription-transaction.model.js";

const isConfirmed = process.argv.includes("--confirm");

await connectDatabase(env.MONGODB_URI);
try {
  // Safe filter targeting only web testers
  const webFilter = {
    $and: [
      {
        $or: [
          { userId: { $regex: /^web_tester_/ } },
          { userId: "test_curl_user" }
        ]
      },
      { authProvider: "dev" },
      { email: { $in: ["", null] } }
    ]
  };

  const usersToDelete = await UserModel.find(webFilter).lean();
  const userIds = usersToDelete.map(u => u.userId);

  console.log(`\nFound ${usersToDelete.length} web tester accounts matching safe criteria.`);

  // Find associated relationships
  const relationships = await RelationshipModel.find({ userId: { $in: userIds } }).lean();
  const relIds = relationships.map(r => r._id);

  // Measure data footprint
  const [messagesCount, memoriesCount, memoryJobsCount, swipesCount, subsCount] = await Promise.all([
    MessageModel.countDocuments({ relationshipId: { $in: relIds } }),
    MemoryModel.countDocuments({ $or: [{ userId: { $in: userIds } }, { relationshipId: { $in: relIds } }] }),
    MemoryJobModel.countDocuments({ relationshipId: { $in: relIds } }),
    SwipeModel.countDocuments({ userId: { $in: userIds } }),
    SubscriptionTransactionModel.countDocuments({ userId: { $in: userIds } })
  ]);

  console.log("\nTarget data breakdown:");
  console.log(`- Users: ${usersToDelete.length}`);
  console.log(`- Relationships: ${relationships.length}`);
  console.log(`- Messages: ${messagesCount}`);
  console.log(`- Memories: ${memoriesCount}`);
  console.log(`- Memory Jobs: ${memoryJobsCount}`);
  console.log(`- Swipes: ${swipesCount}`);
  console.log(`- Subscription Transactions: ${subsCount}`);

  if (!isConfirmed) {
    console.log("\n[DRY RUN] No data was deleted. Pass --confirm to execute deletion.");
    process.exit(0);
  }

  console.log("\n[CONFIRMED] Executing deletion...");
  const [delJobs, delMemories, delMessages, delSwipes, delSubs, delRel, delUsers] = await Promise.all([
    MemoryJobModel.deleteMany({ relationshipId: { $in: relIds } }),
    MemoryModel.deleteMany({ $or: [{ userId: { $in: userIds } }, { relationshipId: { $in: relIds } }] }),
    MessageModel.deleteMany({ relationshipId: { $in: relIds } }),
    SwipeModel.deleteMany({ userId: { $in: userIds } }),
    SubscriptionTransactionModel.deleteMany({ userId: { $in: userIds } }),
    RelationshipModel.deleteMany({ _id: { $in: relIds } }),
    UserModel.deleteMany({ _id: { $in: usersToDelete.map(u => u._id) } })
  ]);

  console.log("\nDeletion Summary:");
  console.log(`- Users deleted: ${delUsers.deletedCount}`);
  console.log(`- Relationships deleted: ${delRel.deletedCount}`);
  console.log(`- Messages deleted: ${delMessages.deletedCount}`);
  console.log(`- Memories deleted: ${delMemories.deletedCount}`);
  console.log(`- Memory Jobs deleted: ${delJobs.deletedCount}`);
  console.log(`- Swipes deleted: ${delSwipes.deletedCount}`);
  console.log(`- Subscription Transactions deleted: ${delSubs.deletedCount}`);
  console.log("\nSuccess: All web tester data has been cleaned up.");
} catch (err) {
  console.error("Deletion error:", err);
  process.exit(1);
} finally {
  await disconnectDatabase();
}
