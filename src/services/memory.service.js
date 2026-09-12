import { MemoryModel } from "../models/memory.model.js";

const stopWords = new Set([
  "about",
  "and",
  "are",
  "did",
  "does",
  "for",
  "from",
  "have",
  "how",
  "just",
  "that",
  "the",
  "this",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);
const terms = (value) =>
  new Set(
    (
      String(value || "")
        .toLowerCase()
        .match(/[\p{L}\p{N}']+/gu) || []
    ).filter((word) => word.length > 2 && !stopWords.has(word)),
  );

export function selectRelevantFallbackMemories(memories, query, limit = 8) {
  const queryTerms = terms(query);
  const recallRequest =
    /\b(remember|recall|what do you know|what did i tell)\b/i.test(query);
  return memories
    .map((memory, index) => {
      const memoryTerms = terms(
        `${memory.normalizedKey || ""} ${memory.text || ""}`,
      );
      let score = [...queryTerms].reduce(
        (sum, word) => sum + (memoryTerms.has(word) ? 2 : 0),
        0,
      );
      if (String(memory.normalizedKey || "").startsWith("user_boundary_"))
        score += 5;
      if (recallRequest) score += Number(memory.importance || 0);
      return { memory, index, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.memory.importance || 0) - Number(a.memory.importance || 0) ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map(({ memory }) => memory);
}

export async function retrieveMemories({
  relationshipId,
  userId,
  query,
  embeddingProvider,
  vectorIndexName,
  vectorEnabled,
  limit = 8,
  signal,
}) {
  const candidates = await MemoryModel.find({
    relationshipId,
    userId,
    status: "active",
  })
    .sort({ importance: -1, updatedAt: -1 })
    .limit(50)
    .select("type text importance normalizedKey")
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
            normalizedKey: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
      ]);
    } catch (error) {
      console.warn(
        "Vector memory retrieval failed; using structured fallback",
        error,
      );
    }
  }
  const relevantSemantic = semantic.filter(
    (memory) => Number(memory.score || 0) >= 0.7,
  );
  const fallback = selectRelevantFallbackMemories(candidates, query, limit);
  const merged = new Map(
    [...relevantSemantic, ...fallback].map((memory) => [
      memory._id.toString(),
      memory,
    ]),
  );
  const selected = [...merged.values()].slice(0, limit);
  if (selected.length > 0) {
    await MemoryModel.updateMany(
      { _id: { $in: selected.map((memory) => memory._id) } },
      { $set: { lastRetrievedAt: new Date() } },
    );
  }
  return selected;
}
