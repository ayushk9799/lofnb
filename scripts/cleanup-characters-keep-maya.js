import { format as formatCliOutput } from 'node:util';
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { SwipeModel } from "../src/models/swipe.model.js";
import { MemoryModel } from "../src/models/memory.model.js";
import { MemoryJobModel } from "../src/models/memory-job.model.js";

async function main() {
  void process.stdout.write(formatCliOutput("🔌 Connecting to database...") + '\n');
  await connectDatabase(env.MONGODB_URI);

  try {
    const maya = await CharacterModel.findOne({ slug: "maya" });
    if (!maya) {
      throw new Error("🚨 ABORT: Maya character not found in database! No changes made.");
    }

    void process.stdout.write(formatCliOutput(`✅ Verified Maya exists in database: ID = ${maya._id}, Name = "${maya.name}"`) + '\n');

    const nonMayaChars = await CharacterModel.find({ _id: { $ne: maya._id } }, "_id slug name").lean();
    const nonMayaIds = nonMayaChars.map(c => c._id);

    void process.stdout.write(formatCliOutput(`Found ${nonMayaIds.length} non-Maya character(s) to delete.`) + '\n');

    if (nonMayaIds.length === 0) {
      void process.stdout.write(formatCliOutput("🎉 Database already has only Maya. Nothing to delete!") + '\n');
      return;
    }

    // Perform deletions
    const [delChars, delRels, delMsgs, delSwipes, delMems, delJobs] = await Promise.all([
      CharacterModel.deleteMany({ _id: { $in: nonMayaIds } }),
      RelationshipModel.deleteMany({ characterId: { $in: nonMayaIds } }),
      MessageModel.deleteMany({ characterId: { $in: nonMayaIds } }),
      SwipeModel.deleteMany({ characterId: { $in: nonMayaIds } }),
      MemoryModel.deleteMany({ characterId: { $in: nonMayaIds } }),
      MemoryJobModel.deleteMany({ characterId: { $in: nonMayaIds } })
    ]);

    void process.stdout.write(formatCliOutput("\n🧹 Cleanup Results:") + '\n');
    void process.stdout.write(formatCliOutput(`- Characters deleted:    ${delChars.deletedCount}`) + '\n');
    void process.stdout.write(formatCliOutput(`- Relationships deleted: ${delRels.deletedCount}`) + '\n');
    void process.stdout.write(formatCliOutput(`- Messages deleted:      ${delMsgs.deletedCount}`) + '\n');
    void process.stdout.write(formatCliOutput(`- Swipes deleted:        ${delSwipes.deletedCount}`) + '\n');
    void process.stdout.write(formatCliOutput(`- Memories deleted:      ${delMems.deletedCount}`) + '\n');
    void process.stdout.write(formatCliOutput(`- Memory jobs deleted:   ${delJobs.deletedCount}`) + '\n');

    // Verification
    const remainingChars = await CharacterModel.find({}, "slug name").lean();
    void process.stdout.write(formatCliOutput(`\n🔍 Verification: Remaining characters in DB: ${remainingChars.length}`) + '\n');
    remainingChars.forEach(c => void process.stdout.write(formatCliOutput(`   - ${c.name} (${c.slug})`) + '\n'));

    const mayaRels = await RelationshipModel.countDocuments({ characterId: maya._id });
    const mayaMsgs = await MessageModel.countDocuments({ characterId: maya._id });
    void process.stdout.write(formatCliOutput(`✅ Maya active relationships remaining: ${mayaRels}`) + '\n');
    void process.stdout.write(formatCliOutput(`✅ Maya messages remaining: ${mayaMsgs}`) + '\n');
  } finally {
    await disconnectDatabase();
  }
}

main().catch(err => {
  console.error("❌ Cleanup failed:", err);
  process.exit(1);
});
