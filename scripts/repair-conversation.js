import "dotenv/config";
import mongoose from "mongoose";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserModel } from "../src/models/user.model.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { MemoryModel } from "../src/models/memory.model.js";
import { MemoryJobModel } from "../src/models/memory-job.model.js";
import {
  temporaryPlanTiming,
  refreshDossier,
} from "../src/services/dossier.service.js";

// Targeted recovery for the audited Maya conversation. Dry run is the default;
// preserve a private rollback snapshot before changing any saved state.
const email = process.argv
  .find((argument) => argument.startsWith("--email="))
  ?.slice(8);
if (!email) throw new Error("Use --email=<account> [--apply]");
await mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10_000,
});
try {
  const user = await UserModel.findOne({ email }).lean();
  const character = await CharacterModel.findOne({ slug: "maya" }).lean();
  if (!user || !character) throw new Error("Account or Maya not found");
  const relationship = await RelationshipModel.findOne({
    userId: user.userId,
    characterId: character._id,
  }).lean();
  if (!relationship) throw new Error("Maya relationship not found");
  const messages = await MessageModel.find({
    relationshipId: relationship._id,
    status: "completed",
  })
    .sort({ sequenceNumber: 1 })
    .lean();
  if (
    messages.at(-1)?.sequenceNumber !== 57 ||
    messages.filter((message) => message.role === "user").at(-1)
      ?.sequenceNumber !== 55
  )
    throw new Error(
      "Conversation has changed since the audited transcript; review the new turns before repairing",
    );
  const refusal = messages.find(
    (message) =>
      message.role === "user" &&
      message.content === "I don’t want to talk about this darling",
  );
  if (!refusal)
    throw new Error(
      "Audited topic refusal not found; refusing to apply a generic repair",
    );
  const memories = await MemoryModel.find({
    relationshipId: relationship._id,
    status: "active",
  }).lean();
  const jobs = await MemoryJobModel.find({
    relationshipId: relationship._id,
    status: "failed",
  }).lean();
  const temporary = memories.filter(
    (memory) => memory.dossierCategory === "current_life",
  );
  console.log(
    JSON.stringify({
      temporaryMemories: temporary.length,
      failedJobs: jobs.length,
      declinedTopic: "detective guessing game",
      apply: process.argv.includes("--apply"),
    }),
  );
  if (process.argv.includes("--apply")) {
    const backupDirectory = await mkdtemp(
      join(tmpdir(), "lofn-conversation-repair-"),
    );
    const backupPath = join(backupDirectory, "snapshot.json");
    await writeFile(
      backupPath,
      JSON.stringify({ relationship, memories, jobs }, null, 2),
      { mode: 0o600 },
    );
    await mongoose.connection.transaction(async (session) => {
      const current = await RelationshipModel.findOne({
        _id: relationship._id,
        updatedAt: relationship.updatedAt,
        $or: [
          { "chatLease.expiresAt": { $exists: false } },
          { "chatLease.expiresAt": { $lt: new Date() } },
        ],
      }).session(session);
      if (!current)
        throw new Error(
          "Conversation changed or has an active reply; rerun after it finishes",
        );
      for (const memory of temporary) {
        const sources = messages.filter((message) =>
          memory.sourceMessageIds?.some(
            (id) => String(id) === String(message._id),
          ),
        );
        const original = sources.find(
          (message) =>
            message.role === "user" &&
            memory.evidence &&
            message.content.includes(memory.evidence),
        );
        const occurredAt = original?.createdAt || memory.createdAt;
        const timing = temporaryPlanTiming(
          memory.text,
          occurredAt,
          user.timezone,
        );
        if (timing)
          await MemoryModel.updateOne(
            { _id: memory._id, updatedAt: memory.updatedAt },
            { $set: { text: timing.text, expiresAt: timing.expiresAt } },
            { session, timestamps: false },
          );
      }
      if (
        messages.some(
          (message) =>
            message.role === "user" &&
            message.content === "I work in software though",
        ) &&
        messages.some(
          (message) =>
            message.role === "user" &&
            message.content === "It a fun actually , atleast for me",
        )
      ) {
        await MemoryModel.updateOne(
          {
            relationshipId: current._id,
            normalizedKey: "profession_software",
            status: "active",
          },
          {
            $set: { text: "The user works in software and enjoys debugging." },
          },
          { session, timestamps: false },
        );
      }
      const latestUser = messages
        .filter((message) => message.role === "user")
        .at(-1);
      const closedTopics = [...(current.turnState?.closedTopics || [])].map(
        (entry) => ({ topic: entry.topic, evidence: entry.evidence }),
      );
      if (
        !closedTopics.some((entry) => entry.topic === "detective guessing game")
      )
        closedTopics.push({
          topic: "detective guessing game",
          evidence: refusal.content,
        });
      current.turnState = {
        sequence: latestUser.sequenceNumber,
        topic: "software debugging",
        engagement: "engaged",
        move: "share",
        wantsSpace: false,
        closedTopics: closedTopics.slice(-12),
        recentTopics: [
          "detective/movie/popcorn jokes",
          "spreadsheet comparisons",
          "missing semicolon jokes",
        ],
      };
      current.conversationState.pendingQuestion = "";
      if (
        current.conversationState.scene?.expiresAt &&
        current.conversationState.scene.expiresAt < new Date()
      )
        current.conversationState.scene = undefined;
      await refreshDossier(current, session);
      await current.save({ session });
    });
    // Retry only scene-validation failures. The fixed extractor retains valid
    // facts; arbitrary unrelated failures are not silently reclassified.
    const retryIds = jobs
      .filter(
        (job) =>
          job.lastError?.includes('"scene"') &&
          !job.lastError.includes('"memories"'),
      )
      .map((job) => job._id);
    const result = await MemoryJobModel.updateMany(
      { _id: { $in: retryIds }, status: "failed" },
      {
        $set: { status: "pending", attempts: 0, availableAt: new Date() },
        $unset: { lockedAt: 1, lockToken: 1, lastError: 1 },
      },
    );
    console.log(
      JSON.stringify({
        repaired: true,
        retriedJobs: result.modifiedCount,
        backupPath,
      }),
    );
  }
} finally {
  await mongoose.disconnect();
}
