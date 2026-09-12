import { Router } from "express";
import { upload } from "../middleware/upload.js";
import { createHash } from "node:crypto";

import { HttpError } from "../utils/http-error.js";
export const uploadRouter = Router();
export const storageRouter = Router();
uploadRouter.post("/", upload.single("file"), async (request, response, next) => {
    try {
        if (!request.file) {
            throw new HttpError(400, "No file provided in request", "BAD_REQUEST");
        }
        let folder;
        if (request.body?.relationshipId) {
            folder = `messages/${request.body.relationshipId}`;
        } else {
            folder = `users/${createHash("sha256").update(request.auth.userId).digest("hex")}`;
        }
        const result = await request.app.locals.storage.upload({
            buffer: request.file.buffer,
            originalFilename: request.file.originalname,
            mimeType: request.file.mimetype,
            folder,
        });
        response.status(201).json({
            data: result,
        });
    }
    catch (error) {
        next(error);
    }
});
storageRouter.get("/{*key}", async (request, response, next) => {
    try {
        const rawKey = request.params.key;
        const key = Array.isArray(rawKey) ? rawKey.join("/") : String(rawKey || "");
        if (!key) {
            throw new HttpError(400, "Missing storage key", "BAD_REQUEST");
        }
        const object = await request.app.locals.storage.getObject(key);
        if (!object) {
            throw new HttpError(404, "File not found", "NOT_FOUND");
        }
        if (object.contentType) {
            response.setHeader("Content-Type", object.contentType);
        }
        if (object.contentLength) {
            response.setHeader("Content-Length", object.contentLength);
        }
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        object.stream.on("error", (error) => {
            if (response.headersSent) response.destroy(error);
            else next(error);
        });
        response.on("close", () => object.stream.destroy());
        object.stream.pipe(response);
    }
    catch (error) {
        next(error);
    }
});
