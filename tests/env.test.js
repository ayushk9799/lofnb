import { describe, expect, it } from "vitest";
import { loadEnvironment } from "../src/config/env.js";
import { createLlmProvider } from "../src/providers/provider-factory.js";

describe("environment configuration with OpenAI defaults", () => {
  it("automatically configures gpt-4o-mini and OpenAI base URL when OPENAI_API_KEY is supplied", () => {
    const parsed = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      OPENAI_API_KEY: "sk-test-key-12345",
    });

    expect(parsed.LLM_API_KEY).toBe("sk-test-key-12345");
    expect(parsed.LLM_BASE_URL).toBe("https://api.openai.com/v1");
    expect(parsed.LLM_MODEL).toBe("gpt-4o-mini");
    expect(parsed.EMBEDDING_API_KEY).toBe("sk-test-key-12345");
    expect(parsed.EMBEDDING_BASE_URL).toBe("https://api.openai.com/v1");
    expect(parsed.EMBEDDING_MODEL).toBe("text-embedding-3-small");
    expect(parsed.DAILY_REWARD_COOLDOWN_SECONDS).toBe(86400);
    expect(parsed.WELCOME_HEARTS).toBe(100);
    expect(parsed.FREE_MESSAGES_PER_COMPANION).toBe(10);
    expect(parsed.COMPANION_OFFLINE_MINUTES).toBe(480);

    const provider = createLlmProvider(parsed);
    expect(provider).toBeDefined();
    expect(provider?.model).toBe("gpt-4o-mini");
  });

  it("allows the daily reward cooldown to be disabled for local testing", () => {
    const parsed = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      DAILY_REWARD_COOLDOWN_SECONDS: "0",
    });

    expect(parsed.DAILY_REWARD_COOLDOWN_SECONDS).toBe(0);
  });

  it("defaults an invalid free message cap to 10 and accepts a custom cap", () => {
    const missing = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
    });
    expect(missing.FREE_MESSAGES_PER_COMPANION).toBe(10);

    const invalid = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      FREE_MESSAGES_PER_COMPANION: "nope",
    });
    expect(invalid.FREE_MESSAGES_PER_COMPANION).toBe(10);

    const custom = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      FREE_MESSAGES_PER_COMPANION: "8",
    });
    expect(custom.FREE_MESSAGES_PER_COMPANION).toBe(8);
  });

  it("defaults an invalid companion offline duration to 8 hours and accepts minutes or hours", () => {
    const missing = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
    });
    expect(missing.COMPANION_OFFLINE_MINUTES).toBe(480);

    const invalid = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      COMPANION_OFFLINE_MINUTES: "nope",
    });
    expect(invalid.COMPANION_OFFLINE_MINUTES).toBe(480);

    const customMinutes = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      COMPANION_OFFLINE_MINUTES: "6",
    });
    expect(customMinutes.COMPANION_OFFLINE_MINUTES).toBe(6);

    const customHours = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      COMPANION_OFFLINE_HOURS: "8",
    });
    expect(customHours.COMPANION_OFFLINE_MINUTES).toBe(480);
  });

  it("respects custom LLM_MODEL or LLM_API_KEY if specified", () => {
    const parsed = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      LLM_API_KEY: "sk-custom-key",
      LLM_MODEL: "gpt-4o",
    });

    expect(parsed.LLM_API_KEY).toBe("sk-custom-key");
    expect(parsed.LLM_MODEL).toBe("gpt-4o");
    expect(parsed.LLM_BASE_URL).toBe("https://api.openai.com/v1");
  });

  it("automatically configures openrouter/auto and OpenRouter base URL when OPENROUTER_API_KEY is supplied", () => {
    const parsed = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      OPENROUTER_API_KEY: "sk-or-v1-testkey123",
    });

    expect(parsed.LLM_API_KEY).toBe("sk-or-v1-testkey123");
    expect(parsed.LLM_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(parsed.LLM_MODEL).toBe("openrouter/auto");
    expect(parsed.EMBEDDING_API_KEY).toBe("sk-or-v1-testkey123");
    expect(parsed.EMBEDDING_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(parsed.EMBEDDING_MODEL).toBe("text-embedding-3-small");

    const provider = createLlmProvider(parsed);
    expect(provider).toBeDefined();
    expect(provider?.model).toBe("openrouter/auto");
  });

  it("respects custom LLM_MODEL when OPENROUTER_API_KEY is supplied", () => {
    const parsed = loadEnvironment({
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      OPENROUTER_API_KEY: "sk-or-v1-testkey123",
      LLM_MODEL: "anthropic/claude-3.5-sonnet",
    });

    expect(parsed.LLM_API_KEY).toBe("sk-or-v1-testkey123");
    expect(parsed.LLM_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(parsed.LLM_MODEL).toBe("anthropic/claude-3.5-sonnet");
  });
});
