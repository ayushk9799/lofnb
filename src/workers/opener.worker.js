import { RelationshipModel } from "../models/relationship.model.js";
import { UserModel } from "../models/user.model.js";
import { withChatLease } from "../services/chat.service.js";
import { getCompanionAvailability } from "../services/chat-quota.service.js";
import { initiateScenario } from "../services/scenario.service.js";

/**
 * Sends the companion's first text for freshly matched relationships whose
 * opener is due. Scheduling happens in the swipe route; this only fires them.
 * A relationship is claimed by clearing openerDueAt before generating so two
 * workers cannot send twice; a failure re-arms it a minute later.
 */
export async function processDueOpeners({ llm, env, signal, limit = 10 }) {
    if (!llm) return;
    for (let i = 0; i < limit; i += 1) {
        if (signal?.aborted) break;
        const relationship = await RelationshipModel.findOneAndUpdate(
            {
                openerDueAt: { $lte: new Date() },
                openerSentAt: { $exists: false },
                $or: [
                    { "chatLease.expiresAt": { $exists: false } },
                    { "chatLease.expiresAt": { $lt: new Date() } },
                ],
            },
            { $unset: { openerDueAt: 1 } },
            { sort: { openerDueAt: 1 }, new: false },
        ).lean();
        if (!relationship) break;
        try {
            const availability = await getCompanionAvailability({
                userId: relationship.userId,
                relationshipId: relationship._id,
                env,
            });
            if (availability.companionOffline) {
                await RelationshipModel.updateOne(
                    { _id: relationship._id, openerSentAt: { $exists: false } },
                    { $set: { openerSentAt: new Date() } },
                );
                continue;
            }
            const user = await UserModel.findOne({ userId: relationship.userId }).select("timezone").lean();
            await withChatLease(relationship._id, relationship.userId, async leaseSignal => {
                const combined = AbortSignal.any([signal || new AbortController().signal, leaseSignal]);
                await initiateScenario({
                    relationshipId: relationship._id,
                    userId: relationship.userId,
                    llm,
                    userTimezone: user?.timezone,
                    triggerType: "opener",
                    signal: combined,
                });
            });
        } catch (error) {
            console.error(`[opener] failed for relationship ${relationship._id}:`, error.message);
            await RelationshipModel.updateOne(
                { _id: relationship._id, openerSentAt: { $exists: false } },
                { $set: { openerDueAt: new Date(Date.now() + 60_000) } },
            ).catch(() => undefined);
        }
    }
}

export function startOpenerWorker(dependencies) {
    const controller = new AbortController();
    let pending;
    const tick = () => {
        if (pending || controller.signal.aborted) return;
        pending = (async () => {
            try {
                await processDueOpeners({ ...dependencies, signal: controller.signal });
            } catch (error) {
                console.error("Opener worker error:", error.message);
            } finally {
                pending = undefined;
            }
        })();
    };
    const timer = setInterval(tick, dependencies.pollIntervalMs || 10_000);
    timer.unref();
    tick();
    return async () => {
        clearInterval(timer);
        controller.abort();
        await pending;
    };
}
