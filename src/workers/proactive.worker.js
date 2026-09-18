import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { CharacterModel } from "../models/character.model.js";
import { withChatLease } from "../services/chat.service.js";
import { initiateScenario } from "../services/scenario.service.js";

export const LEFT_ON_READ_MS = 60_000;
export const GONE_OFFLINE_MS = 2 * 60_000;
export const LATE_REPLY_MS = 90_000;

function ageMs(date, now) {
    if (!date) return 0;
    return now - new Date(date).getTime();
}

export function classifyProactiveTrigger(relationship, lastMessage, now = Date.now(), delays = {}) {
    const leftOnReadMs = delays.leftOnReadMs ?? LEFT_ON_READ_MS;
    const goneOfflineMs = delays.goneOfflineMs ?? GONE_OFFLINE_MS;
    const lateReplyMs = delays.lateReplyMs ?? LATE_REPLY_MS;
    if (!lastMessage) return null;
    if (lastMessage.role === "assistant" && lastMessage.origin === "initiated") return null;
    if (lastMessage.role === "user") {
        return ageMs(lastMessage.createdAt, now) >= lateReplyMs ? "check_in" : null;
    }
    const isRead = (relationship.userLastReadSequence || 0) >= lastMessage.sequenceNumber;
    if (isRead) {
        const readAt = relationship.userLastReadAt || lastMessage.createdAt;
        return ageMs(readAt, now) >= leftOnReadMs ? "left_on_read" : null;
    }
    return ageMs(lastMessage.createdAt, now) >= goneOfflineMs ? "idle_nudge" : null;
}

export async function processProactiveCheckIns({
    llm,
    signal,
    leftOnReadMs = LEFT_ON_READ_MS,
    goneOfflineMs = GONE_OFFLINE_MS,
    lateReplyMs = LATE_REPLY_MS,
}) {
    if (!llm) return;
    const now = Date.now();
    const staleMs = Math.min(leftOnReadMs, goneOfflineMs, lateReplyMs);
    const candidates = await RelationshipModel.find({
        lastMessageAt: { $lt: new Date(now - staleMs) },
        $or: [
            { "chatLease.expiresAt": { $exists: false } },
            { "chatLease.expiresAt": { $lt: new Date(now) } },
        ],
    }).limit(20);

    const delays = { leftOnReadMs, goneOfflineMs, lateReplyMs };
    for (const relationship of candidates) {
        if (signal?.aborted) break;
        try {
            const lastMessage = await MessageModel.findOne({ relationshipId: relationship._id })
                .sort({ sequenceNumber: -1 })
                .lean();
            const triggerType = classifyProactiveTrigger(relationship, lastMessage, now, delays);
            if (!triggerType) continue;

            const character = await CharacterModel.findById(relationship.characterId).lean();
            if (!character) continue;

            await withChatLease(relationship._id, relationship.userId, async leaseSignal => {
                const combinedSignal = AbortSignal.any([
                    signal || new AbortController().signal,
                    leaseSignal,
                ]);
                await initiateScenario({
                    relationshipId: relationship._id,
                    userId: relationship.userId,
                    llm,
                    userTimezone: character.timezone,
                    triggerType,
                    signal: combinedSignal,
                });
            });

            await RelationshipModel.updateOne(
                { _id: relationship._id },
                { $set: { lastInitiatedAt: new Date() } }
            );
        } catch (error) {
            console.error(`Proactive check-in failed for relationship ${relationship._id}:`, error.message);
        }
    }
}

export function startProactiveWorker(dependencies) {
    const controller = new AbortController();
    let pending;
    const tick = () => {
        if (pending || controller.signal.aborted) return;
        pending = (async () => {
            try {
                await processProactiveCheckIns({ ...dependencies, signal: controller.signal });
            } catch (err) {
                console.error("Proactive worker error:", err.message);
            } finally {
                pending = undefined;
            }
        })();
    };
    const timer = setInterval(tick, dependencies.pollIntervalMs || 15_000);
    timer.unref();
    tick();
    return async () => {
        clearInterval(timer);
        controller.abort();
        await pending;
    };
}
