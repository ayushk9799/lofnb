import { Schema, model } from "mongoose";

const userSchema = new Schema({
    userId: { type: String, required: true, unique: true, index: true },
    // Private, opaque customer identifier shared with RevenueCat.
    // Existing users may not have this field until their next authenticated login.
    accountId: { type: String, unique: true, sparse: true, index: true },
    email: { type: String, lowercase: true, trim: true, default: "" },
    authProvider: { type: String, enum: ["google", "apple", "dev"], default: "dev" },
    providerId: { type: String, default: "" },
    name: { type: String, default: "", maxlength: 80 },
    bio: { type: String, default: "", maxlength: 500 },
    interestedIn: {
        type: [{ type: String, enum: ["female", "male"] }],
        default: [],
    },
    avatarUrl: { type: String, default: "" },
    avatarKey: { type: String, default: "" },
    vibe: {
        type: String,
        enum: ["Everyone", "Creative", "Playful", "Warm", "Curious", "Adventurous"],
        default: "Everyone",
    },
    age: { type: Number, min: 16, max: 120 },
    minAge: { type: Number, default: 18, min: 18, max: 100 },
    maxAge: { type: Number, default: 60, min: 18, max: 100 },
    timezone: { type: String, maxlength: 100, default: "" },
    fcmToken: { type: String, default: "", index: true },
    platform: { type: String, enum: ["ios", "android", "web", ""], default: "" },
    deviceInfoUpdatedAt: { type: Date },
    isPremium: { type: Boolean, default: false, index: true },
    premiumEntitlement: { type: String, default: "" },
    premiumExpiresAt: { type: Date },
    revenueCatAppUserId: { type: String, index: true },
    revenueCatEventAt: { type: Date },
    lastDailyHeartsClaimedAt: { type: Date, default: null },
    onboardedAt: { type: Date, default: null },
}, { timestamps: true });

export const UserModel = model("User", userSchema);
