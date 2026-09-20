import { Schema, model } from "mongoose";

const reportSchema = new Schema(
    {
        userId: { type: String, required: true, index: true },
        relationshipId: {
            type: Schema.Types.ObjectId,
            ref: "Relationship",
            index: true,
        },
        messageId: {
            type: Schema.Types.ObjectId,
            ref: "Message",
        },
        characterId: {
            type: Schema.Types.ObjectId,
            ref: "Character",
        },
        reason: {
            type: String,
            required: true,
            maxlength: 200,
        },
        details: {
            type: String,
            default: "",
            maxlength: 2000,
        },
        contentSnapshot: {
            type: String,
            default: "",
            maxlength: 5000,
        },
        status: {
            type: String,
            enum: ["pending", "reviewed", "dismissed"],
            default: "pending",
        },
    },
    { timestamps: true }
);

reportSchema.index({ userId: 1, createdAt: -1 });

export const ReportModel = model("Report", reportSchema);
