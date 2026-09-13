process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/lofn_test";
for (const key of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY", "EMBEDDING_API_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"]) process.env[key] = "";
