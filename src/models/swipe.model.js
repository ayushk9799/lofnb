import { Schema, model } from "mongoose";

const swipeSchema = new Schema(
    {
        userId: { type: String, required: true, immutable: true, index: true },
        characterId: {
            type: Schema.Types.ObjectId,
            ref: "Character",
            required: true,
            immutable: true,
        },
        clientSwipeId: { type: String, required: true, immutable: true },
        direction: {
            type: String,
            enum: ["like", "pass"],
            required: true,
            immutable: true,
        },
        outcome: {
            type: String,
            enum: ["recorded", "matched"],
            required: true,
            immutable: true,
        },
        relationshipId: {
            type: Schema.Types.ObjectId,
            ref: "Relationship",
        },
        occurredAt: { type: Date },
    },
    { timestamps: true },
);

swipeSchema.index({ userId: 1, clientSwipeId: 1 }, { unique: true });
swipeSchema.index({ userId: 1, characterId: 1 }, { unique: true });

export const SwipeModel = model("Swipe", swipeSchema);
