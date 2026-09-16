import { Schema, model } from "mongoose";

const subscriptionTransactionSchema = new Schema(
    {
        userId: { type: String, required: true, index: true },
        revenueCatAppUserId: { type: String, index: true },
        eventId: { type: String, required: true, unique: true, index: true },
        eventType: {
            type: String,
            required: true,
            index: true,
        },
        productId: { type: String, default: "" },
        price: { type: Number, default: 0 },
        currency: { type: String, default: "USD" },
        store: {
            type: String,
            default: "UNKNOWN",
        },
        environment: {
            type: String,
            enum: ["SANDBOX", "PRODUCTION"],
            default: "PRODUCTION",
            index: true,
        },
        countryCode: { type: String, default: "" },
        periodType: { type: String, default: "NORMAL" },
        renewalNumber: { type: Number, default: 1 },
        isTrialConversion: { type: Boolean, default: false },
        cancelReason: { type: String, default: "" },
        purchasedAt: { type: Date },
        expiresAt: { type: Date },
        rawPayload: { type: Schema.Types.Mixed },
    },
    { timestamps: true }
);

export const SubscriptionTransactionModel = model(
    "SubscriptionTransaction",
    subscriptionTransactionSchema
);
