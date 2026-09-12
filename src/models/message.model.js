import { Schema, model } from "mongoose";
const messageSchema = new Schema({
    relationshipId: {
        type: Schema.Types.ObjectId,
        ref: "Relationship",
        required: true,
        immutable: true,
    },
    sequenceNumber: { type: Number, required: true, immutable: true },
    role: {
        type: String,
        enum: ["user", "assistant"],
        required: true,
        immutable: true,
    },
    content: { type: String, default: "", maxlength: 100_000 },
    mediaUrl: { type: String, trim: true },
    mediaKey: { type: String, trim: true },
    mediaType: { type: String, enum: ["image", "audio"], default: undefined },
    mediaMeta: {
        width: Number,
        height: Number,
        size: Number,
    },
    status: {
        type: String,
        enum: ["pending", "streaming", "completed", "partial", "failed"],
        required: true,
    },
    clientMessageId: { type: String, maxlength: 160 },
    replyToMessageId: { type: Schema.Types.ObjectId, ref: "Message" },
    memoryExtractedAt: Date,
    memoryPending: { type: Boolean, default: false },
    origin: { type: String, enum: ["reply", "initiated"], default: "reply" },
    generation: {
        provider: String,
        model: String,
        inputTokens: Number,
        outputTokens: Number,
        latencyMs: Number,
        finishReason: String,
        retrievedMemoryIds: [{ type: Schema.Types.ObjectId, ref: "Memory" }],
    },
    completedAt: { type: Date },
    readAt: { type: Date },
}, { timestamps: true });
messageSchema.index({ relationshipId: 1, sequenceNumber: 1 }, { unique: true });
messageSchema.index({ relationshipId: 1, createdAt: -1 });
messageSchema.index({ relationshipId: 1, clientMessageId: 1 }, {
    unique: true,
    partialFilterExpression: { clientMessageId: { $type: "string" } },
});
messageSchema.index({ relationshipId: 1, replyToMessageId: 1 }, {
    unique: true,
    partialFilterExpression: { replyToMessageId: { $type: "objectId" } },
});
export const MessageModel = model("Message", messageSchema);
