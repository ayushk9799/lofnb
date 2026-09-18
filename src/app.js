import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createAuthMiddleware } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { StorageService } from "./services/storage.service.js";
import { authRouter } from "./routes/auth.routes.js";
import { charactersRouter } from "./routes/characters.routes.js";
import { discoveryRouter } from "./routes/discovery.routes.js";
import { createChatRouter } from "./routes/chat.routes.js";
import { mediaRouter } from "./routes/media.routes.js";
import { memoriesRouter } from "./routes/memories.routes.js";
import { profileRouter } from "./routes/profile.routes.js";
import { createRelationshipsRouter } from "./routes/relationships.routes.js";
import { swipesRouter } from "./routes/swipes.routes.js";
import { storageRouter, uploadRouter } from "./routes/upload.routes.js";
import { createWebhookRouter } from "./routes/webhook.routes.js";
import { createCurrencyRouter } from "./routes/currency.routes.js";
export function createApp({ env, llm, visionLlm, embeddingProvider, mediaProvider, storage = new StorageService(env) }) {
    const app = express();
    app.locals.storage = storage;
    app.locals.env = env;
    app.locals.matchRate = env.MATCH_RATE ?? 1;
    app.disable("x-powered-by");
    app.use(helmet({ crossOriginResourcePolicy: false }));
    app.use(cors({
        origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
        allowedHeaders: ["Content-Type", "x-user-id", "x-timezone", "Authorization"],
        methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }));
    app.use(express.json({ limit: "128kb" }));
    // Static uploads directory for local fallback storage
    app.use("/uploads", storageRouter);
    // Public storage proxy for R2 / local media retrieval (needed for standard <img> tags)
    app.use("/api/storage", storageRouter);
    app.get("/health", (_request, response) => {
        response.json({ status: "ok" });
    });
    // Public auth endpoints
    app.use("/api/auth", authRouter);
    app.use("/api/login", authRouter);
    // Public webhooks endpoint (e.g. RevenueCat)
    app.use("/api/webhooks", createWebhookRouter({ env }));
    app.use("/api", createAuthMiddleware(env));
    app.use("/api/profile", profileRouter);
    app.use("/api/user/profile", profileRouter);
    app.use("/api/user", profileRouter);
    app.use("/api/gems", createCurrencyRouter({ env }));
    app.use("/api/currency", createCurrencyRouter({ env }));
    app.use("/api/upload", uploadRouter);
    app.use("/api/discovery", discoveryRouter);
    app.use("/api/swipes", swipesRouter);
    app.use("/api/characters", charactersRouter);
    app.use("/api/relationships", createRelationshipsRouter({ env }));
    app.use("/api/relationships/:relationshipId/media", mediaRouter);
    app.use("/api/relationships/:relationshipId/chat", createChatRouter({ env, llm, visionLlm, embeddingProvider, mediaProvider, storage }));
    app.use("/api/relationships/:relationshipId/memories", memoriesRouter);
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
}
