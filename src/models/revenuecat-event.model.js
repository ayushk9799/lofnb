import { Schema, model } from "mongoose";

const revenueCatEventSchema = new Schema({
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, default: "" },
    receivedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
});

export const RevenueCatEventModel = model("RevenueCatEvent", revenueCatEventSchema);
