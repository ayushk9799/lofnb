import { format as formatCliOutput } from 'node:util';
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

  void process.stdout.write(formatCliOutput(`\nFound ${usersToDelete.length} web tester accounts matching safe criteria.`) + '\n');

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

  void process.stdout.write(formatCliOutput("\nTarget data breakdown:") + '\n');
  void process.stdout.write(formatCliOutput(`- Users: ${usersToDelete.length}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Relationships: ${relationships.length}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Messages: ${messagesCount}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Memories: ${memoriesCount}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Memory Jobs: ${memoryJobsCount}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Swipes: ${swipesCount}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Subscription Transactions: ${subsCount}`) + '\n');

  if (!isConfirmed) {
    void process.stdout.write(formatCliOutput("\n[DRY RUN] No data was deleted. Pass --confirm to execute deletion.") + '\n');
    process.exit(0);
  }

  void process.stdout.write(formatCliOutput("\n[CONFIRMED] Executing deletion...") + '\n');
  const [delJobs, delMemories, delMessages, delSwipes, delSubs, delRel, delUsers] = await Promise.all([
    MemoryJobModel.deleteMany({ relationshipId: { $in: relIds } }),
    MemoryModel.deleteMany({ $or: [{ userId: { $in: userIds } }, { relationshipId: { $in: relIds } }] }),
    MessageModel.deleteMany({ relationshipId: { $in: relIds } }),
    SwipeModel.deleteMany({ userId: { $in: userIds } }),
    SubscriptionTransactionModel.deleteMany({ userId: { $in: userIds } }),
    RelationshipModel.deleteMany({ _id: { $in: relIds } }),
    UserModel.deleteMany({ _id: { $in: usersToDelete.map(u => u._id) } })
  ]);

  void process.stdout.write(formatCliOutput("\nDeletion Summary:") + '\n');
  void process.stdout.write(formatCliOutput(`- Users deleted: ${delUsers.deletedCount}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Relationships deleted: ${delRel.deletedCount}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Messages deleted: ${delMessages.deletedCount}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Memories deleted: ${delMemories.deletedCount}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Memory Jobs deleted: ${delJobs.deletedCount}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Swipes deleted: ${delSwipes.deletedCount}`) + '\n');
  void process.stdout.write(formatCliOutput(`- Subscription Transactions deleted: ${delSubs.deletedCount}`) + '\n');
  void process.stdout.write(formatCliOutput("\nSuccess: All web tester data has been cleaned up.") + '\n');
} catch (err) {
  console.error("Deletion error:", err);
  process.exit(1);
} finally {
  await disconnectDatabase();
}
