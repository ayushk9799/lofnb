import "dotenv/config";
import { z } from "zod";
const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.url().optional());
const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional());
const schema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    MONGODB_URI: z.string().min(1),
    SESSION_SECRET: optionalString,
    CORS_ORIGIN: z.string().default("http://localhost:5173"),
    MATCH_RATE: z.coerce.number().min(0).max(1).default(1),
    OPENAI_API_KEY: optionalString,
    OPENAI_MODEL: optionalString,
    OPENROUTER_API_KEY: optionalString,
    LLM_BASE_URL: optionalUrl,
    LLM_API_KEY: optionalString,
    LLM_MODEL: optionalString,
    VISION_MODEL: optionalString,
    TRANSCRIPTION_MODEL: optionalString,
    AUDIO_MODEL: optionalString,
    SPEECH_MODEL: optionalString,
    IMAGE_GENERATION_MODEL: optionalString,
    SPEECH_VOICE: optionalString,
    MEMORY_VECTOR_SEARCH_ENABLED: z
        .enum(["true", "false"])
        .default("false")
        .transform((value) => value === "true"),
    MEMORY_VECTOR_INDEX: z.string().default("memory_vector_index"),
    EMBEDDING_BASE_URL: optionalUrl,
    EMBEDDING_API_KEY: optionalString,
    EMBEDDING_MODEL: optionalString,
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
    GOOGLE_CLIENT_ID: optionalString.default("50299044849-tl8kc7h49rcbl5aicfs41eg49tf3bmkn.apps.googleusercontent.com"),
    APPLE_CLIENT_ID: optionalString.default("com.thousandways.lofn"),
    APPLE_CLIENT_IDS: optionalString,
    ALLOW_DEV_AUTH: z
        .enum(["true", "false"])
        .default("false")
        .transform((value) => value === "true"),
    R2_ACCOUNT_ID: optionalString,
    R2_ACCESS_KEY_ID: optionalString,
    R2_SECRET_ACCESS_KEY: optionalString,
    R2_BUCKET_NAME: optionalString,
    R2_PUBLIC_URL: optionalUrl,
    REVENUECAT_WEBHOOK_SECRET: optionalString,
    REVENUECAT_PROJECT_ID: optionalString,
    REVENUECAT_SECRET_KEY: optionalString,
    REVENUECAT_ENTITLEMENT_ID: z.string().default("premium"),
    DAILY_REWARD_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(86400),
});
export function loadEnvironment(source = process.env) {
    const isOpenRouter = Boolean(
        source.OPENROUTER_API_KEY ||
        (source.LLM_BASE_URL && String(source.LLM_BASE_URL).includes("openrouter.ai"))
    );
    const effectiveApiKey = source.OPENROUTER_API_KEY || source.LLM_API_KEY || source.OPENAI_API_KEY;
    const effectiveEmbeddingKey = source.EMBEDDING_API_KEY || source.OPENROUTER_API_KEY || source.OPENAI_API_KEY || source.LLM_API_KEY;
    const defaultBaseUrl = isOpenRouter ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1";
    const defaultModel = isOpenRouter ? "openrouter/auto" : "gpt-4o-mini";
    const defaultEmbeddingBaseUrl = isOpenRouter ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1";
    const normalized = {
        ...source,
        MONGODB_URI: source.MONGODB_URI ||
            (source.NODE_ENV === "test" ? "mongodb://localhost:27017/lofn_test" : undefined),
        LLM_API_KEY: effectiveApiKey,
        LLM_BASE_URL: source.LLM_BASE_URL ||
            (effectiveApiKey ? defaultBaseUrl : undefined),
        LLM_MODEL: source.LLM_MODEL ||
            source.OPENAI_MODEL ||
            (effectiveApiKey ? defaultModel : undefined),
        VISION_MODEL: source.VISION_MODEL ||
            (effectiveApiKey ? (isOpenRouter ? "openai/gpt-5.6-luna" : "gpt-5.6-luna") : undefined),
        TRANSCRIPTION_MODEL: source.TRANSCRIPTION_MODEL ||
            (effectiveApiKey ? (isOpenRouter ? "openai/gpt-transcribe" : "gpt-transcribe") : undefined),
        // Chat model with native audio input; the fallback when the
        // transcription endpoint fails or cannot decode a voice note.
        AUDIO_MODEL: source.AUDIO_MODEL ||
            (effectiveApiKey ? (isOpenRouter ? "google/gemini-2.5-flash" : "gpt-4o-audio-preview") : undefined),
        SPEECH_MODEL: source.SPEECH_MODEL ||
            (effectiveApiKey ? (isOpenRouter ? "openai/gpt-audio-mini" : "gpt-4o-mini-tts") : undefined),
        IMAGE_GENERATION_MODEL: source.IMAGE_GENERATION_MODEL ||
            (effectiveApiKey ? (isOpenRouter ? "openai/gpt-image-2.5-flare" : "gpt-image-2.5-flare") : undefined),
        SPEECH_VOICE: source.SPEECH_VOICE || "alloy",
        EMBEDDING_API_KEY: effectiveEmbeddingKey,
        EMBEDDING_BASE_URL: source.EMBEDDING_BASE_URL ||
            (effectiveEmbeddingKey ? defaultEmbeddingBaseUrl : undefined),
        EMBEDDING_MODEL: source.EMBEDDING_MODEL ||
            (effectiveEmbeddingKey ? "text-embedding-3-small" : undefined),
    };
    const result = schema.safeParse(normalized);
    if (!result.success) {
        const details = result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ");
        throw new Error(`Invalid environment configuration: ${details}`);
    }
    return result.data;
}
export const env = loadEnvironment();
