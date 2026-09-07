import { Schema, model } from "mongoose";
const memoryJobSchema = new Schema({
    relationshipId: {
        type: Schema.Types.ObjectId,
        ref: "Relationship",
        required: true,
        immutable: true,
    },
    userMessageId: {
        type: Schema.Types.ObjectId,
        ref: "Message",
        required: true,
        immutable: true,
    },
    assistantMessageId: {
        type: Schema.Types.ObjectId,
        ref: "Message",
        required: true,
        immutable: true,
        unique: true,
    },
    status: {
        type: String,
        enum: ["pending", "processing", "completed", "failed"],
        default: "pending",
        index: true,
    },
    attempts: { type: Number, default: 0 },
    availableAt: { type: Date, default: Date.now, index: true },
    lockToken: String,
    lockedAt: { type: Date },
    lastError: { type: String, maxlength: 2_000 },
}, { timestamps: true });
memoryJobSchema.index({ status: 1, availableAt: 1 });
export const MemoryJobModel = model("MemoryJob", memoryJobSchema);
