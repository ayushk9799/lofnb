import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { MemoryModel } from "../src/models/memory.model.js";
import { createEmbeddingProvider, createLlmProvider } from "../src/providers/provider-factory.js";
import { backfillEmbeddings, backfillDossiers, missingEmbeddings } from "../src/services/memory-maintenance.service.js";

const apply = process.argv.includes("--apply");
const provider = createEmbeddingProvider({...env, MEMORY_VECTOR_SEARCH_ENABLED: true});
if (!provider) throw new Error("Configure an embedding provider before running memory maintenance");
const definition = {fields: [
  {type: "vector", path: "embedding", numDimensions: provider.dimensions, similarity: "cosine"},
  ...["relationshipId", "userId", "status", "embeddingModel"].map(path => ({type: "filter", path})),
]};
const signature = value => JSON.stringify((value?.fields || []).map(field => ({
  path: field.path, type: field.type, numDimensions: field.numDimensions, similarity: field.similarity,
})).sort((a, b) => a.path.localeCompare(b.path)));
await mongoose.connect(env.MONGODB_URI, {autoIndex: false, serverSelectionTimeoutMS: 10_000});
try {
  const collection = MemoryModel.collection;
  const indexes = await collection.listSearchIndexes().toArray();
  const existing = indexes.find(index => index.name === env.MEMORY_VECTOR_INDEX);
  const count = await MemoryModel.countDocuments(missingEmbeddings(provider));
  if (apply) {
    // Verify credentials/model/dimensions before changing the search index.
    await provider.embed("Memory search readiness check");
    if (!existing) {
      await collection.createSearchIndex({name: env.MEMORY_VECTOR_INDEX, type: "vectorSearch", definition});
    } else if (signature(existing.latestDefinition) !== signature(definition)) {
      if (existing.type !== "vectorSearch") throw new Error("Configured index name belongs to a non-vector index");
      await collection.updateSearchIndex(env.MEMORY_VECTOR_INDEX, definition);
    }
    const embedded = await backfillEmbeddings(provider, {progress: n => {if (n % 10 === 0) console.log(`Embedded ${n} memories`);}});
    if (process.argv.includes("--dossiers")) {
      const llm = createLlmProvider(env);
      if (!llm) throw new Error("Configure a chat provider to review legacy dossier facts");
      const reviewed = await backfillDossiers(llm, {signal: AbortSignal.timeout(600_000), progress: n => console.log(`Reviewed ${n} legacy memories`)});
    }
  }
  const status = await collection.listSearchIndexes(env.MEMORY_VECTOR_INDEX).toArray();
} finally { await mongoose.disconnect(); }
