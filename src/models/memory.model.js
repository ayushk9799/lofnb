import { Schema, model } from "mongoose";
const memorySchema = new Schema({
    relationshipId: {
        type: Schema.Types.ObjectId,
        ref: "Relationship",
        required: true,
        immutable: true,
    },
    userId: { type: String, required: true, immutable: true },
    characterId: {
        type: Schema.Types.ObjectId,
        ref: "Character",
        required: true,
        immutable: true,
    },
    type: {
        type: String,
        enum: [
            "user_fact",
            "shared_event",
            "character_event",
            "preference",
            "lore_detail",
        ],
        required: true,
    },
    text: { type: String, required: true, maxlength: 2_000 },
    normalizedKey: { type: String, required: true, maxlength: 240 },
    sourceMessageIds: [{ type: Schema.Types.ObjectId, ref: "Message" }],
    confidence: { type: Number, default: 0.8, min: 0, max: 1 },
    importance: { type: Number, default: 0.5, min: 0, max: 1 },
    dossierCategory: { type: String, enum: ["fact", "preference", "habit", "inside_joke", "current_life"] },
    evidence: { type: String, maxlength: 2000 },
    dossierReviewedAt: Date,
    dossierReviewVersion: Number,
    expiresAt: Date,
    lastMentionedAt: Date,
    status: {
        type: String,
        enum: ["active", "superseded", "deleted"],
        default: "active",
    },
    embedding: { type: [Number], select: false, default: undefined },
    embeddingModel: { type: String, select: false },
    sourceSequence: { type: Number, default: 0 },
    deletedAt: Date,
    lastRetrievedAt: { type: Date },
}, { timestamps: true });
memorySchema.index({ relationshipId: 1, normalizedKey: 1, status: 1 }, { unique: true, partialFilterExpression: { status: "active" } });
memorySchema.index({ relationshipId: 1, status: 1, importance: -1, updatedAt: -1 });
memorySchema.index({ userId: 1, characterId: 1, status: 1 });
export const MemoryModel = model("Memory", memorySchema);
