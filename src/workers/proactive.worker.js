import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { UserModel } from "../models/user.model.js";
import { MemoryModel } from "../models/memory.model.js";
import { withChatLease } from "../services/chat.service.js";
import { getCompanionAvailability } from "../services/chat-quota.service.js";
import { presenceContext } from "../services/presence.service.js";
import { initiateScenario } from "../services/scenario.service.js";
import { logger } from "../utils/logger.js";

export const LEFT_ON_READ_MS = 6 * 60 * 60_000;
export const GONE_OFFLINE_MS = 6 * 60 * 60_000;
export const LATE_REPLY_MS = 90_000;
export const IDLE_NUDGE_MS = 30 * 60_000;

function ageMs(date, now) {
    if (!date) return 0;
    return now - new Date(date).getTime();
}

export function classifyProactiveTrigger(relationship, lastMessage, now = Date.now(), delays = {}) {
    const leftOnReadMs = delays.leftOnReadMs ?? LEFT_ON_READ_MS;
    const goneOfflineMs = delays.goneOfflineMs ?? GONE_OFFLINE_MS;
    const lateReplyMs = delays.lateReplyMs ?? LATE_REPLY_MS;
    const idleNudgeMs = delays.idleNudgeMs ?? IDLE_NUDGE_MS;

    if (!lastMessage || lastMessage.status && lastMessage.status !== "completed") return null;
    if (lastMessage.role === "user") {
        if (/\b(good\s?night|bye|talk later|not now|leave me alone|stop messaging|need (?:some )?space)\b/i.test(lastMessage.content || "")) return null;
        return ageMs(lastMessage.createdAt, now) >= lateReplyMs ? "check_in" : null;
    }

    if (relationship.turnState?.wantsSpace) return null;
    const visit = relationship.returnVisit;
    const returnReady = visit && !visit.processedAt && new Date(visit.dueAt).getTime() <= now
        && new Date(visit.expiresAt).getTime() > now && visit.sourceSequence === lastMessage.sequenceNumber;
    // A fresh viewing session can reopen an unanswered check-in, but never on
    // every heartbeat or a rapid reopen. Background check-ins have a longer cap.
    if (returnReady && (!relationship.lastInitiatedAt || ageMs(relationship.lastInitiatedAt, now) >= 60 * 60_000)) return "return_to_chat";
    if (relationship.lastProactiveAttemptAt && ageMs(relationship.lastProactiveAttemptAt, now) < 30 * 60_000) return null;
    if (relationship.lastInitiatedAt && ageMs(relationship.lastInitiatedAt, now) < 24 * 60 * 60_000) return null;
    if (lastMessage.origin === "initiated") return ageMs(lastMessage.createdAt, now) >= 24 * 60 * 60_000 ? "callback" : null;
    // Assistant message pending user engagement
    const state = relationship.conversationState || {};
    const messageAge = ageMs(lastMessage.createdAt, now);

    // After 6 hours: callback if there is an active thread or scene
    const callbackDelay = Math.max(leftOnReadMs, goneOfflineMs);
    if (messageAge >= callbackDelay) {
        if (relationship.lastInitiatedAt && ageMs(relationship.lastInitiatedAt, now) < 24 * 60 * 60_000) return null;
        if (relationship.turnState?.move === "pivot" || relationship.turnState?.engagement === "fading" || state.activeThread || (state.scene?.status === "active" && new Date(state.scene.expiresAt).getTime() > now)) {
            return "callback";
        }
        return null;
    }

    // Between idleNudgeMs and callbackDelay: re-engage user after a meaningful pause
    if (messageAge >= idleNudgeMs) {
        return "idle_nudge";
    }

    return null;
}

export async function processProactiveCheckIns({
    llm,
    env,
    signal,
    mediaProvider,
    storage,
    leftOnReadMs = LEFT_ON_READ_MS,
    goneOfflineMs = GONE_OFFLINE_MS,
    lateReplyMs = LATE_REPLY_MS,
    idleNudgeMs = env?.IDLE_NUDGE_MS ?? IDLE_NUDGE_MS,
}) {
    if (!llm) return;
    const now = Date.now();
    const staleMs = Math.min(leftOnReadMs, goneOfflineMs, lateReplyMs, idleNudgeMs);
    const candidates = await RelationshipModel.find({
        lastMessageAt: { $lt: new Date(now - staleMs) },
        $or: [
            { "chatLease.expiresAt": { $exists: false } },
            { "chatLease.expiresAt": { $lt: new Date(now) } },
        ],
    }).sort({proactiveCheckedAt: 1}).limit(20);

    const delays = { leftOnReadMs, goneOfflineMs, lateReplyMs, idleNudgeMs };
    for (const relationship of candidates) {
        if (signal?.aborted) break;
        try {
            // Claim the candidate so parallel server instances split the batch
            // instead of all evaluating the same relationships.
            const claimed = await RelationshipModel.updateOne(
                {_id: relationship._id, proactiveCheckedAt: relationship.proactiveCheckedAt ?? null},
                {$set: {proactiveCheckedAt: new Date()}},
            );
            if (!claimed.modifiedCount) continue;
            const lastMessage = await MessageModel.findOne({ relationshipId: relationship._id })
                .sort({ sequenceNumber: -1 })
                .lean();
            const triggerType = classifyProactiveTrigger(relationship, lastMessage, now, delays);
            if (!triggerType) continue;

            if (triggerType === "return_to_chat" && !(await presenceContext(relationship.userId, relationship._id)).viewingChat) continue;

            const availability = await getCompanionAvailability({
                userId: relationship.userId,
                relationshipId: relationship._id,
                env,
            });
            if (availability.companionOffline) continue;

            const user = await UserModel.findOne({userId: relationship.userId}).select("timezone").lean();
            if (triggerType === "callback" || triggerType === "idle_nudge" || triggerType === "return_to_chat") {
                if (triggerType !== "return_to_chat" && await RelationshipModel.exists({userId: relationship.userId, lastInitiatedAt: {$gt: new Date(now - 4 * 60 * 60_000)}})) continue;
                // Conservative: preferences concerning space/contact disable auto callbacks.
                if (await MemoryModel.exists({relationshipId: relationship._id, status: "active", normalizedKey: /^user_boundary_/, text: /space|contact|message|text|quiet|alone|notification|initiat/i})) continue;
            }

            await withChatLease(relationship._id, relationship.userId, async leaseSignal => {
                const combinedSignal = AbortSignal.any([
                    signal || new AbortController().signal,
                    leaseSignal,
                ]);
                const fresh = await RelationshipModel.findById(relationship._id).lean();
                const newest = await MessageModel.findOne({relationshipId: relationship._id}).sort({sequenceNumber: -1}).lean();
                if (!fresh || newest?.sequenceNumber !== lastMessage.sequenceNumber || classifyProactiveTrigger(fresh, newest, Date.now(), delays) !== triggerType) return;
                const presence = await presenceContext(relationship.userId, relationship._id);
                if (triggerType === "return_to_chat") {
                    if (!presence.viewingChat) return;
                    const claimed = await RelationshipModel.updateOne({_id: fresh._id, "returnVisit.startedAt": fresh.returnVisit.startedAt, "returnVisit.processedAt": {$exists: false}}, {$set: {"returnVisit.processedAt": new Date()}});
                    if (!claimed.modifiedCount) return;
                }
                const initiated = await initiateScenario({
                    relationshipId: relationship._id,
                    userId: relationship.userId,
                    llm,
                    userTimezone: user?.timezone,
                    expectedSequence: newest.sequenceNumber,
                    presence: {...presence, ...(triggerType === "return_to_chat" ? {absenceMs: fresh.returnVisit.absenceMs} : {})},
                    triggerType,
                    signal: combinedSignal,
                    mediaProvider,
                    storage,
                    env,
                });
                if (!initiated) await RelationshipModel.updateOne({ _id: relationship._id }, { $set: { lastProactiveAttemptAt: new Date() } });
            });

        } catch (error) {
            if (error.code === "CHAT_BUSY" || error.status === 409) {
                // Another turn is already in progress; quietly skip without log spam
                continue;
            }
            logger.error({ err: error, relationshipId: String(relationship._id) }, "Proactive check-in failed");
            // Apply a backoff cooldown on failure so we don't hammer the relationship every 15 seconds
            await RelationshipModel.updateOne(
                { _id: relationship._id },
                { $set: { lastProactiveAttemptAt: new Date() } },
            ).catch(() => undefined);
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
                logger.error({ err }, "Proactive worker tick failed");
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
