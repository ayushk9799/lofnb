import { randomUUID } from "node:crypto";
import { MemoryJobModel } from "../models/memory-job.model.js";
import { MessageModel } from "../models/message.model.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { extractAndStoreMemory } from "../services/memory-extraction.service.js";
import { enqueueMemory } from "../services/chat.service.js";

export async function recoverChatWork() {
    for (const message of await MessageModel.find({status: "completed", memoryPending: true}).limit(50)) await enqueueMemory(message);
    const stale = await MessageModel.find({status: "streaming", updatedAt: {$lt: new Date(Date.now() - 120_000)}}).limit(50);
    for (const message of stale) {
        const active = await RelationshipModel.exists({_id: message.relationshipId, "chatLease.expiresAt": {$gt: new Date()}});
        if (!active) await MessageModel.updateOne({_id: message._id, status: "streaming", updatedAt: message.updatedAt}, {$set: {
            status: message.content ? "partial" : "failed", completedAt: new Date(),
        }});
    }
}
export async function processMemoryJob({llm, embeddingProvider, signal}) {
    const token = randomUUID();
    const job = await MemoryJobModel.findOneAndUpdate({availableAt: {$lte: new Date()}, $or: [
        {status: "pending"}, {status: "processing", lockedAt: {$lt: new Date(Date.now() - 180_000)}},
    ]}, {$set: {status: "processing", lockedAt: new Date(), lockToken: token}, $inc: {attempts: 1}}, {new: true, sort: {createdAt: 1}});
    if (!job) return;
    let update;
    try {
        await extractAndStoreMemory({relationshipId: job.relationshipId, userMessageId: job.userMessageId,
            assistantMessageId: job.assistantMessageId, llm, embeddingProvider,
            signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(120_000)]),
        });
        update = {$set: {status: "completed"}, $unset: {lastError: 1, lockToken: 1, lockedAt: 1}};
    } catch (error) {
        update = {$set: {status: job.attempts >= 3 ? "failed" : "pending",
            availableAt: new Date(Date.now() + 2 ** Math.min(job.attempts, 8) * 2000),
            lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        }, $unset: {lockToken: 1, lockedAt: 1}};
    }
    await MemoryJobModel.updateOne({_id: job._id, lockToken: token}, update);
}
export function startMemoryWorker(dependencies) {
    const controller = new AbortController();
    let pending;
    let lastRecovery = 0;
    const tick = () => {
        if (pending || controller.signal.aborted) return;
        pending = (async () => {
            try {
                if (Date.now() - lastRecovery > 30_000) { await recoverChatWork(); lastRecovery = Date.now(); }
                await processMemoryJob({...dependencies, signal: controller.signal});
            } catch (err) {
                console.error("Memory worker database operation failed; retrying on next tick:", err.message);
            }
            finally { pending = undefined; }
        })();
    };
    const timer = setInterval(tick, dependencies.pollIntervalMs || 1500);
    timer.unref(); tick();
    return async () => { clearInterval(timer); controller.abort(); await pending; };
}
