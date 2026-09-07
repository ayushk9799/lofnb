import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { CharacterModel } from "../models/character.model.js";
import { withChatLease } from "../services/chat.service.js";
import { initiateScenario } from "../services/scenario.service.js";

function getLocalHour(timeZone) {
    try {
        const str = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(new Date());
        return parseInt(str, 10);
    } catch {
        return new Date().getUTCHours();
    }
}

export async function processProactiveCheckIns({
    llm,
    signal,
    offlineThresholdMs = 3 * 3600 * 1000,
    cooldownMs = 6 * 3600 * 1000,
}) {
    if (!llm) return;
    const now = Date.now();
    const candidates = await RelationshipModel.find({
        lastMessageAt: { $lt: new Date(now - offlineThresholdMs) },
        $and: [
            {
                $or: [
                    { lastInitiatedAt: { $exists: false } },
                    { lastInitiatedAt: { $lt: new Date(now - cooldownMs) } },
                ],
            },
            {
                $or: [
                    { "chatLease.expiresAt": { $exists: false } },
                    { "chatLease.expiresAt": { $lt: new Date(now) } },
                ],
            },
        ],
    }).limit(10);

    for (const relationship of candidates) {
        if (signal?.aborted) break;
        try {
            const character = await CharacterModel.findById(relationship.characterId).lean();
            if (!character) continue;

            const localHour = getLocalHour(character.timezone || "America/New_York");
            if (localHour < 9 || localHour >= 22) continue;

            const lastMessage = await MessageModel.findOne({ relationshipId: relationship._id })
                .sort({ sequenceNumber: -1 })
                .lean();

            if (!lastMessage) continue;
            if (lastMessage.role === "assistant" && lastMessage.origin === "initiated") {
                continue;
            }

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
                    triggerType: "check_in",
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
    const timer = setInterval(tick, dependencies.pollIntervalMs || 60_000);
    timer.unref();
    tick();
    return async () => {
        clearInterval(timer);
        controller.abort();
        await pending;
    };
}
