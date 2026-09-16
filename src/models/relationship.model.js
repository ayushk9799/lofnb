import { Schema, model } from "mongoose";
const relationshipSchema = new Schema({
    userId: { type: String, required: true, immutable: true, index: true },
    characterId: {
        type: Schema.Types.ObjectId,
        ref: "Character",
        required: true,
        immutable: true,
    },
    stage: {
        type: String,
        enum: ["new", "friends", "close", "romantic"],
        default: "new",
    },
    mood: {
        type: String,
        enum: ["neutral", "happy", "playful", "sad", "annoyed"],
        default: "neutral",
    },
    relationshipSummary: { type: String, default: "", maxlength: 8_000 },
    media: {
        avatarUrl: String,
        avatarKey: String,
        gallery: { type: [{ url: {type: String, required: true}, caption: {type: String, maxlength: 240}, key: String }], default: undefined },
    },
    memoryRevision: { type: Number, default: 0 },
    contextAfterSequence: { type: Number, default: 0 },
    introduction: {
        nameStatus: { type: String, enum: ["unknown", "known", "declined"], default: "unknown" },
        preferredName: { type: String, maxlength: 80 },
    },
    introductionSequence: { type: Number, default: 0 },
    stageEvidence: { type: String, maxlength: 2000 },
    summarySequence: { type: Number, default: 0 },
    chatLease: { token: String, expiresAt: Date },
    lastMessageAt: { type: Date },
    lastInitiatedAt: { type: Date },
    // When the match was decided. Kept separate from createdAt so a delayed
    // reveal can be modelled later without touching the document's birth.
    matchedAt: { type: Date },
    // The companion texts first shortly after a match. openerDueAt is when the
    // opener worker may send it; openerSentAt marks it done (or skipped).
    openerDueAt: { type: Date },
    openerSentAt: { type: Date },
    userLastReadSequence: { type: Number, default: 0, min: 0 },
    userLastReadAt: { type: Date },
    companionLastReadSequence: { type: Number, default: 0, min: 0 },
    companionLastReadAt: { type: Date },
    nextSequence: { type: Number, default: 0, min: 0, select: false },
}, { timestamps: true });
relationshipSchema.index({ userId: 1, characterId: 1 }, { unique: true });
relationshipSchema.index({ openerDueAt: 1 }, { partialFilterExpression: { openerDueAt: { $exists: true } } });
export const RelationshipModel = model("Relationship", relationshipSchema);
