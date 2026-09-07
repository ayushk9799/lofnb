import mongoose from "mongoose";
import { MemoryModel } from "../models/memory.model.js";
import { MessageModel } from "../models/message.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { HttpError } from "../utils/http-error.js";
import { withChatLease } from "./chat.service.js";

// Conservative forgetting: retain the visible transcript, but never feed pre-forget
// messages or their summary back to extraction/generation. No unreliable text redaction.
export async function forgetMemory({relationshipId, userId, memoryId}) {
    return withChatLease(relationshipId, userId, async () => {
        await mongoose.connection.transaction(async session => {
            const memory = await MemoryModel.findOne({_id: memoryId, relationshipId, userId}).session(session);
            if (!memory) throw new HttpError(404, "Memory not found", "NOT_FOUND");
            const relationship = await RelationshipModel.findById(relationshipId).session(session);
            const forgetName = memory.normalizedKey.startsWith("user_name") || (relationship.introduction?.preferredName && memory.text.includes(relationship.introduction.preferredName));
            const latest = await MessageModel.findOne({relationshipId}).sort({sequenceNumber: -1}).session(session);
            await MemoryModel.updateMany({relationshipId, userId, $or: [
                {normalizedKey: memory.normalizedKey}, {text: memory.text},
            ]}, {$set: {status: "deleted", deletedAt: new Date()}, $unset: {embedding: 1, embeddingModel: 1}}, {session});
            await RelationshipModel.updateOne({_id: relationshipId, userId}, {
                $max: {contextAfterSequence: latest?.sequenceNumber || 0},
                $set: {relationshipSummary: "", stageEvidence: "", ...(forgetName ? {introduction: {nameStatus: "unknown"}} : {})},
            }, {session});
        });
    });
}
