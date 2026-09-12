import { Schema, model } from "mongoose";

const userSchema = new Schema({
    userId: { type: String, required: true, unique: true, index: true },
    email: { type: String, lowercase: true, trim: true, default: "" },
    authProvider: { type: String, enum: ["google", "apple", "dev"], default: "dev" },
    providerId: { type: String, default: "" },
    name: { type: String, default: "", maxlength: 80 },
    bio: { type: String, default: "", maxlength: 500 },
    avatarUrl: { type: String, default: "" },
    avatarKey: { type: String, default: "" },
    vibe: {
        type: String,
        enum: ["Everyone", "Creative", "Playful", "Warm", "Curious", "Adventurous"],
        default: "Everyone",
    },
    minAge: { type: Number, default: 18, min: 18, max: 100 },
    maxAge: { type: Number, default: 60, min: 18, max: 100 },
    timezone: { type: String, maxlength: 100, default: "" },
    fcmToken: { type: String, default: "", index: true },
    platform: { type: String, enum: ["ios", "android", "web", ""], default: "" },
    deviceInfoUpdatedAt: { type: Date },
}, { timestamps: true });

export const UserModel = model("User", userSchema);
