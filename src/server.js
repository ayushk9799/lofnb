import { createServer } from "node:http";
import { createApp } from "./app.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import { createEmbeddingProvider, createLlmProvider, } from "./providers/provider-factory.js";
import { startMemoryWorker } from "./workers/memory.worker.js";
import { startProactiveWorker } from "./workers/proactive.worker.js";
const llm = createLlmProvider(env);
const embeddingProvider = createEmbeddingProvider(env);
await connectDatabase(env.MONGODB_URI);
const app = createApp({ env, llm, embeddingProvider });
const server = createServer(app);
const stopMemoryWorker = llm
    ? startMemoryWorker({ llm, embeddingProvider })
    : () => undefined;
const stopProactiveWorker = llm
    ? startProactiveWorker({ llm })
    : () => undefined;
server.listen(env.PORT, () => {
    console.log(`Lofn API listening on http://localhost:${env.PORT}`);
    console.log(env.MEMORY_VECTOR_SEARCH_ENABLED
        ? "Vector memory retrieval enabled"
        : "Using structured memory retrieval; vector search is disabled");
});
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);
    const drained = Promise.all([stopMemoryWorker(), stopProactiveWorker()]);
    server.close(async () => {
        await drained;
        await disconnectDatabase();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
