import { MemoryModel } from "../models/memory.model.js";
export async function retrieveMemories({ relationshipId, userId, query, embeddingProvider, vectorIndexName, vectorEnabled, limit = 8, signal, }) {
    const pinned = await MemoryModel.find({
        relationshipId,
        userId,
        status: "active",
        importance: { $gte: 0.8 },
    })
        .sort({ importance: -1, updatedAt: -1 })
        .limit(6)
        .select("type text importance")
        .lean();
    let semantic = [];
    if (vectorEnabled && embeddingProvider && query.trim()) {
        try {
            const queryVector = await embeddingProvider.embed(query, signal);
            semantic = await MemoryModel.aggregate([
                {
                    $vectorSearch: {
                        index: vectorIndexName,
                        path: "embedding",
                        queryVector,
                        numCandidates: Math.max(limit * 20, 100),
                        limit,
                        filter: {
                            relationshipId: { $eq: relationshipId },
                            userId: { $eq: userId },
                            status: { $eq: "active" },
                        },
                    },
                },
                {
                    $project: {
                        type: 1,
                        text: 1,
                        importance: 1,
                        score: { $meta: "vectorSearchScore" },
                    },
                },
            ]);
        }
        catch (error) {
            console.warn("Vector memory retrieval failed; using structured fallback", error);
        }
    }
    if (semantic.length === 0) {
        semantic = await MemoryModel.find({
            relationshipId,
            userId,
            status: "active",
            _id: { $nin: pinned.map(memory => memory._id) },
        })
            .sort({ importance: -1, updatedAt: -1 })
            .limit(limit)
            .select("type text importance")
            .lean();
    }
    const merged = new Map();
    for (const memory of [...pinned, ...semantic]) {
        merged.set(memory._id.toString(), memory);
    }
    const selected = [...merged.values()].slice(0, limit + 4);
    if (selected.length > 0) {
        await MemoryModel.updateMany({ _id: { $in: selected.map((memory) => memory._id) } }, { $set: { lastRetrievedAt: new Date() } });
    }
    return selected;
}
