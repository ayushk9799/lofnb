import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { SwipeModel } from "../src/models/swipe.model.js";
import { MemoryModel } from "../src/models/memory.model.js";
import { MemoryJobModel } from "../src/models/memory-job.model.js";

async function main() {
  console.log("🔌 Connecting to database...");
  await connectDatabase(env.MONGODB_URI);

  try {
    const maya = await CharacterModel.findOne({ slug: "maya" });
    if (!maya) {
      throw new Error("🚨 ABORT: Maya character not found in database! No changes made.");
    }

    console.log(`✅ Verified Maya exists in database: ID = ${maya._id}, Name = "${maya.name}"`);

    const nonMayaChars = await CharacterModel.find({ _id: { $ne: maya._id } }, "_id slug name").lean();
    const nonMayaIds = nonMayaChars.map(c => c._id);

    console.log(`Found ${nonMayaIds.length} non-Maya character(s) to delete.`);

    if (nonMayaIds.length === 0) {
      console.log("🎉 Database already has only Maya. Nothing to delete!");
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

    console.log("\n🧹 Cleanup Results:");
    console.log(`- Characters deleted:    ${delChars.deletedCount}`);
    console.log(`- Relationships deleted: ${delRels.deletedCount}`);
    console.log(`- Messages deleted:      ${delMsgs.deletedCount}`);
    console.log(`- Swipes deleted:        ${delSwipes.deletedCount}`);
    console.log(`- Memories deleted:      ${delMems.deletedCount}`);
    console.log(`- Memory jobs deleted:   ${delJobs.deletedCount}`);

    // Verification
    const remainingChars = await CharacterModel.find({}, "slug name").lean();
    console.log(`\n🔍 Verification: Remaining characters in DB: ${remainingChars.length}`);
    remainingChars.forEach(c => console.log(`   - ${c.name} (${c.slug})`));

    const mayaRels = await RelationshipModel.countDocuments({ characterId: maya._id });
    const mayaMsgs = await MessageModel.countDocuments({ characterId: maya._id });
    console.log(`✅ Maya active relationships remaining: ${mayaRels}`);
    console.log(`✅ Maya messages remaining: ${mayaMsgs}`);
  } finally {
    await disconnectDatabase();
  }
}

main().catch(err => {
  console.error("❌ Cleanup failed:", err);
  process.exit(1);
});
