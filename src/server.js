import dns from "node:dns";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { env } from "./config/env.js";

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}
import {
  createEmbeddingProvider,
  createLlmProvider,
  createMediaProvider,
  createVisionProvider,
} from "./providers/provider-factory.js";
import { startMemoryWorker } from "./workers/memory.worker.js";
import { startProactiveWorker } from "./workers/proactive.worker.js";
import { startOpenerWorker } from "./workers/opener.worker.js";
import { UserModel } from "./models/user.model.js";
import { RelationshipModel } from "./models/relationship.model.js";
import { MessageModel } from "./models/message.model.js";
import { MemoryModel } from "./models/memory.model.js";

const llm = createLlmProvider(env);
const embeddingProvider = createEmbeddingProvider(env);
const visionLlm = createVisionProvider(env);
const mediaProvider = createMediaProvider(env);
await connectDatabase(env.MONGODB_URI);

// Auto-purge any leftover mock/dev users from database
try {
  const mockFilter = {
    $or: [
      { userId: { $regex: /^(google_dev_|apple_dev_|mock_|lofn-mobile-dev)/ } },
      { email: { $regex: /^(dev_|mock_)/ } },
      { name: { $regex: /^User dev_/ } },
    ],
  };
  const mockUsers = await UserModel.find(mockFilter).select("userId");
  if (mockUsers.length > 0) {
    const ids = mockUsers.map((u) => u.userId);
    // Messages are owned through relationships; they have no userId field.
    // With strictQuery, filtering by that unknown field can become an empty
    // filter and delete everyone's history during startup.
    const relationshipIds = await RelationshipModel.find({userId: {$in: ids}}).distinct("_id");
    await Promise.all([
      UserModel.deleteMany(mockFilter),
      RelationshipModel.deleteMany({ userId: { $in: ids } }),
      MessageModel.deleteMany({ relationshipId: { $in: relationshipIds } }),
      MemoryModel.deleteMany({ userId: { $in: ids } }),
    ]);
   
  }
} catch (err) {
  console.warn("Mock cleanup warning:", err.message);
}

const app = createApp({
  env,
  llm,
  embeddingProvider,
  visionLlm,
  mediaProvider,
});
const server = createServer(app);
const stopMemoryWorker = llm
  ? startMemoryWorker({ llm, embeddingProvider })
  : () => undefined;
const stopProactiveWorker = llm
  ? startProactiveWorker({ llm, env })
  : () => undefined;
const stopOpenerWorker = llm
  ? startOpenerWorker({ llm, env })
  : () => undefined;
server.listen(env.PORT, () => {
  if (app.locals.webDistPath) {
  } else {
  }
 
});
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  const drained = Promise.all([
    stopMemoryWorker(),
    stopProactiveWorker(),
    stopOpenerWorker(),
  ]);
  server.close(async () => {
    await drained;
    await disconnectDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
