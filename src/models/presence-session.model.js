import { Schema, model } from "mongoose";
const schema = new Schema({
  userId: { type: String, required: true },
  sessionId: { type: String, required: true },
  foreground: Boolean,
  relationshipId: { type: Schema.Types.ObjectId, ref: "Relationship" },
  lastActiveAt: Date,
  onlineUntil: Date,
  expiresAt: Date,
});
schema.index({ userId: 1, sessionId: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ userId: 1, relationshipId: 1, onlineUntil: 1 });
export const PresenceSessionModel = model("PresenceSession", schema);
