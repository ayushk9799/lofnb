import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { analyticsRouter } from "./routes/analytics.routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveWebDistPath(env) {
  const candidates = [];
  if (env?.WEB_DIST_PATH) {
    candidates.push(path.resolve(process.cwd(), env.WEB_DIST_PATH));
  }
  // Only serve from lofnb's own internal public directory
  candidates.push(path.resolve(process.cwd(), "public"));
  candidates.push(path.resolve(__dirname, "../public"));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}

export function createApp({
  env,
  llm,
  visionLlm,
  embeddingProvider,
  mediaProvider,
  storage = new StorageService(env),
  webDistPath,
}) {
  const app = express();
  const resolvedWebPath =
    webDistPath !== undefined ? webDistPath : resolveWebDistPath(env);

  app.locals.storage = storage;
  app.locals.env = env;
  app.locals.matchRate = env?.MATCH_RATE ?? 1;
  app.locals.webDistPath = resolvedWebPath;

  app.disable("x-powered-by");
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "img-src": ["'self'", "data:", "blob:", "https:"],
          "connect-src": ["'self'", "https:", "wss:", "http:"],
        },
      },
    }),
  );
  const configuredOrigins = env?.CORS_ORIGIN
    ? env.CORS_ORIGIN.split(",").map((o) => o.trim())
    : [];

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || configuredOrigins.length === 0) return callback(null, true);
        if (configuredOrigins.includes(origin) || configuredOrigins.includes("*")) {
          return callback(null, true);
        }
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        if (/^https:\/\/.*\.vercel\.app$/.test(origin) || origin === "https://lofnchat.com") {
          return callback(null, true);
        }
        callback(null, false);
      },
      allowedHeaders: [
        "Content-Type",
        "x-user-id",
        "x-timezone",
        "Authorization",
      ],
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
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
  // Analytics & product dashboard endpoints
  app.use("/api/analytics", analyticsRouter);
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
  app.use(
    "/api/relationships/:relationshipId/chat",
    createChatRouter({
      env,
      llm,
      visionLlm,
      embeddingProvider,
      mediaProvider,
      storage,
    }),
  );
  app.use("/api/relationships/:relationshipId/memories", memoriesRouter);

  // Serve static frontend assets and SPA fallback when web build is available
  if (resolvedWebPath) {
    app.use(
      express.static(resolvedWebPath, { maxAge: "1d", index: "index.html" }),
    );
    const indexHtmlPath = path.join(resolvedWebPath, "index.html");
    app.use((request, response, next) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return next();
      }
      if (
        request.path.startsWith("/api") ||
        request.path.startsWith("/uploads") ||
        request.path.startsWith("/health")
      ) {
        return next();
      }
      if (path.extname(request.path)) {
        return next();
      }
      response.sendFile(indexHtmlPath, (err) => {
        if (err) next(err);
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
