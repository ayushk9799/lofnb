import { MemoryModel } from "../models/memory.model.js";
import { Types } from "mongoose";

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
        `${(memory.normalizedKey || "").replaceAll("_", " ")} ${memory.text || ""}`,
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
  minScore = 0.6,
}) {
  signal?.throwIfAborted();
  const queryText = String(query || "").slice(0, 6000);
  const queryTerms = [...terms(queryText)].slice(0, 80);
  const recallRequest = /\b(remember|recall|what do you know|what did i tell)\b/i.test(queryText);
  // Match before limiting: an old low-importance cafe memory must still be a
  // candidate even when there are thousands of more important unrelated facts.
  const escaped = queryTerms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const lexicalFilter = recallRequest ? {} : { $or: [
    { normalizedKey: /^user_boundary_/ },
    ...(escaped.length ? [
      { text: { $regex: `(?:${escaped.join("|")})`, $options: "i" } },
      { normalizedKey: { $regex: `(?:${escaped.join("|")})`, $options: "i" } },
    ] : []),
  ] };
  const candidates = await MemoryModel.find({
    relationshipId,
    userId,
    status: "active",
    ...lexicalFilter,
  })
    .sort({ importance: -1, updatedAt: -1 })
    .limit(200)
    .select("type text importance normalizedKey updatedAt expiresAt confidence")
    .lean();
  let semantic = [];
  if (vectorEnabled && embeddingProvider && queryText.trim()) {
    try {
      const queryVector = await embeddingProvider.embed(queryText, signal);
      semantic = await MemoryModel.aggregate([
        {
          $vectorSearch: {
            index: vectorIndexName,
            path: "embedding",
            queryVector,
            numCandidates: Math.max(limit * 40, 200),
            limit: limit * 3,
            filter: {
              relationshipId: { $eq: new Types.ObjectId(String(relationshipId)) },
              userId: { $eq: userId },
              status: { $eq: "active" },
              embeddingModel: { $eq: embeddingProvider.model },
            },
          },
        },
        {
          $project: {
            type: 1,
            text: 1,
            importance: 1,
            normalizedKey: 1,
            updatedAt: 1,
            expiresAt: 1,
            confidence: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
      ]);
    } catch (error) {
      signal?.throwIfAborted();
      console.warn(
        "Vector memory retrieval failed; using structured fallback",
        error.name,
      );
    }
  }
  const relevantSemantic = semantic.filter(
    (memory) => Number(memory.score || 0) >= minScore,
  );
  const fallback = selectRelevantFallbackMemories(candidates, queryText, limit * 3);
  // Reciprocal rank fusion keeps exact names useful alongside paraphrases.
  const merged = new Map();
  for (const list of [relevantSemantic, fallback]) list.forEach((memory, index) => {
    const id = String(memory._id);
    const previous = merged.get(id);
    merged.set(id, {memory: previous?.memory || memory, rank: (previous?.rank || 0) + 1 / (60 + index + 1)});
  });
  const ranked = [...merged.values()].sort((a, b) => b.rank - a.rank || Number(b.memory.importance || 0) - Number(a.memory.importance || 0));
  // Search indexes are eventually consistent. Revalidate against MongoDB before
  // returning text so a just-forgotten or corrected vector result cannot leak.
  const active = await MemoryModel.find({relationshipId, userId, status: "active", _id: {$in: ranked.map(({memory}) => memory._id)}})
    .select("type text importance normalizedKey updatedAt expiresAt confidence").lean();
  const byId = new Map(active.map(memory => [String(memory._id), memory]));
  const keys = new Set();
  const selected = ranked.map(({memory}) => byId.get(String(memory._id))).filter(memory => {
    if (!memory || keys.has(memory.normalizedKey)) return false;
    keys.add(memory.normalizedKey); return true;
  }).slice(0, limit);
  if (selected.length > 0) {
    await MemoryModel.updateMany(
      { _id: { $in: selected.map((memory) => memory._id) } },
      { $set: { lastRetrievedAt: new Date() } },
      { timestamps: false },
    );
  }
  return selected;
}
