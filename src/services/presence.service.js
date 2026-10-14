import { randomInt } from "node:crypto";
import { PresenceSessionModel } from "../models/presence-session.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { requireOwnedRelationship } from "./relationship.service.js";

export const PRESENCE_TTL_MS = 90_000;
export const RETURN_ABSENCE_MS = 30 * 60_000;

export async function recordPresence({
  userId,
  sessionId,
  foreground,
  relationshipId,
  now = new Date(),
}) {
  const relationship =
    foreground && relationshipId
      ? await requireOwnedRelationship(relationshipId, userId)
      : null;
  await PresenceSessionModel.updateOne(
    { userId, sessionId },
    {
      $set: {
        foreground,
        lastActiveAt: now,
        onlineUntil: new Date(+now + (foreground ? PRESENCE_TTL_MS : 0)),
        expiresAt: new Date(+now + 24 * 60 * 60_000),
        ...(relationship ? { relationshipId: relationship._id } : {}),
      },
      ...(!relationship ? { $unset: { relationshipId: 1 } } : {}),
    },
    { upsert: true },
  );
  if (!relationship) return;
  const latest = await MessageModel.findOne({
    relationshipId: relationship._id,
    status: "completed",
  })
    .sort({ sequenceNumber: -1 })
    .select("sequenceNumber createdAt role")
    .lean();
  const lastViewedAt = relationship.lastViewedAt;
  const absenceSince = lastViewedAt || latest?.createdAt;
  const meaningfulReturn =
    latest &&
    absenceSince &&
    +now - new Date(absenceSince).getTime() >= RETURN_ABSENCE_MS;
  // Compare-and-set stops overlapping heartbeats/devices scheduling two visits.
  await RelationshipModel.updateOne(
    {
      _id: relationship._id,
      userId,
      lastViewedAt: lastViewedAt || { $exists: false },
    },
    {
      $set: {
        lastViewedAt: now,
        ...(meaningfulReturn
          ? {
              returnVisit: {
                startedAt: now,
                dueAt: new Date(+now + randomInt(15_000, 45_001)),
                expiresAt: new Date(+now + 5 * 60_000),
                sourceSequence: latest.sequenceNumber,
                absenceMs: +now - new Date(absenceSince).getTime(),
              },
            }
          : {}),
      },
    },
  );
}

export async function presenceContext(
  userId,
  relationshipId,
  now = new Date(),
) {
  const sessions = await PresenceSessionModel.find({
    userId,
    foreground: true,
    onlineUntil: { $gt: now },
  })
    .select("relationshipId")
    .lean();
  return {
    appActive: sessions.length > 0,
    viewingChat: sessions.some(
      (session) => String(session.relationshipId) === String(relationshipId),
    ),
  };
}
