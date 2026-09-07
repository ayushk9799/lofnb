import { OpenAiCompatibleEmbeddingProvider, OpenAiCompatibleProvider, } from "./openai-compatible.provider.js";
export function createLlmProvider(env) {
    if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL)
        return undefined;
    return new OpenAiCompatibleProvider({
        baseUrl: env.LLM_BASE_URL,
        apiKey: env.LLM_API_KEY,
        model: env.LLM_MODEL,
    });
}
export function createEmbeddingProvider(env) {
    if (!env.MEMORY_VECTOR_SEARCH_ENABLED ||
        !env.EMBEDDING_BASE_URL ||
        !env.EMBEDDING_API_KEY ||
        !env.EMBEDDING_MODEL) {
        return undefined;
    }
    return new OpenAiCompatibleEmbeddingProvider({
        baseUrl: env.EMBEDDING_BASE_URL,
        apiKey: env.EMBEDDING_API_KEY,
        model: env.EMBEDDING_MODEL,
        dimensions: env.EMBEDDING_DIMENSIONS,
    });
}
