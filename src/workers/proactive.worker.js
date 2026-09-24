import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { UserModel } from "../models/user.model.js";
import { MemoryModel } from "../models/memory.model.js";
import { withChatLease } from "../services/chat.service.js";
import { getCompanionAvailability } from "../services/chat-quota.service.js";
import { initiateScenario } from "../services/scenario.service.js";

export const LEFT_ON_READ_MS = 6 * 60 * 60_000;
export const GONE_OFFLINE_MS = 6 * 60 * 60_000;
export const LATE_REPLY_MS = 90_000;
export const IDLE_NUDGE_MS = 60_000;

function ageMs(date, now) {
    if (!date) return 0;
    return now - new Date(date).getTime();
}

export function classifyProactiveTrigger(relationship, lastMessage, now = Date.now(), delays = {}) {
    const leftOnReadMs = delays.leftOnReadMs ?? LEFT_ON_READ_MS;
    const goneOfflineMs = delays.goneOfflineMs ?? GONE_OFFLINE_MS;
    const lateReplyMs = delays.lateReplyMs ?? LATE_REPLY_MS;
    const idleNudgeMs = delays.idleNudgeMs ?? (process.env.IDLE_NUDGE_MS ? Number(process.env.IDLE_NUDGE_MS) : IDLE_NUDGE_MS);

    if (!lastMessage || lastMessage.status && lastMessage.status !== "completed") return null;
    if (lastMessage.role === "assistant" && lastMessage.origin === "initiated") return null;
    if (lastMessage.role === "user") {
        if (/\b(good\s?night|bye|talk later|not now|leave me alone|stop messaging|need (?:some )?space)\b/i.test(lastMessage.content || "")) return null;
        return ageMs(lastMessage.createdAt, now) >= lateReplyMs ? "check_in" : null;
    }

    // Assistant message pending user engagement
    const state = relationship.conversationState || {};
    const messageAge = ageMs(lastMessage.createdAt, now);

    // After 6 hours: callback if there is an active thread or scene
    const callbackDelay = Math.max(leftOnReadMs, goneOfflineMs);
    if (messageAge >= callbackDelay) {
        if (relationship.lastInitiatedAt && ageMs(relationship.lastInitiatedAt, now) < 24 * 60 * 60_000) return null;
        if (state.activeThread || state.scene?.description) {
            return "callback";
        }
        return null;
    }

    // Between idleNudgeMs and callbackDelay: re-engage user after inactivity (~1 min)
    if (messageAge >= idleNudgeMs) {
        return "idle_nudge";
    }

    return null;
}

export async function processProactiveCheckIns({
    llm,
    env,
    signal,
    leftOnReadMs = LEFT_ON_READ_MS,
    goneOfflineMs = GONE_OFFLINE_MS,
    lateReplyMs = LATE_REPLY_MS,
    idleNudgeMs = IDLE_NUDGE_MS,
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
    }).limit(20);

    const delays = { leftOnReadMs, goneOfflineMs, lateReplyMs, idleNudgeMs };
    for (const relationship of candidates) {
        if (signal?.aborted) break;
        try {
            const lastMessage = await MessageModel.findOne({ relationshipId: relationship._id })
                .sort({ sequenceNumber: -1 })
                .lean();
            const triggerType = classifyProactiveTrigger(relationship, lastMessage, now, delays);
            if (!triggerType) continue;

            const availability = await getCompanionAvailability({
                userId: relationship.userId,
                relationshipId: relationship._id,
                env,
            });
            if (availability.companionOffline) continue;

            const user = await UserModel.findOne({userId: relationship.userId}).select("timezone").lean();
            if (triggerType === "callback") {
                // No guessed quiet hours. Unknown timezone means no unsolicited callback.
                if (!user?.timezone) continue;
                let hour;
                try { hour = Number(new Intl.DateTimeFormat("en-GB", {timeZone: user.timezone, hour: "numeric", hourCycle: "h23"}).format(now)); }
                catch { continue; }
                if (hour < 9 || hour >= 21) continue;
                if (await RelationshipModel.exists({userId: relationship.userId, lastInitiatedAt: {$gt: new Date(now - 4 * 60 * 60_000)}})) continue;
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
                await initiateScenario({
                    relationshipId: relationship._id,
                    userId: relationship.userId,
                    llm,
                    userTimezone: user?.timezone,
                    expectedSequence: newest.sequenceNumber,
                    triggerType,
                    signal: combinedSignal,
                });
            });

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
