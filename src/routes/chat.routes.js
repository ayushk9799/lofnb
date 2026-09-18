import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { requireObjectId } from "../middleware/error-handler.js";
import { generateReply, withChatLease } from "../services/chat.service.js";
import { getCompanionAvailability } from "../services/chat-quota.service.js";
import { initiateScenario } from "../services/scenario.service.js";
import { requireOwnedRelationship } from "../services/relationship.service.js";
import { MessageModel } from "../models/message.model.js";
import { HttpError } from "../utils/http-error.js";
const optionalPositiveNumber = (max) => z.preprocess((value) => {
    if (value == null || value === "") return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}, z.number().positive().max(max).optional());
const optionalPositiveInt = (max) => z.preprocess((value) => {
    if (value == null || value === "") return undefined;
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : undefined;
}, z.number().int().positive().max(max).optional());
const chatBody = z.object({
    content: z.string().trim().max(20_000).default(""),
    clientMessageId: z.string().min(8).max(160),
    clientGems: z.preprocess((value) => {
        if (value == null || value === "") return 0;
        const n = Math.round(Number(value));
        return Number.isFinite(n) && n >= 0 ? n : 0;
    }, z.number().int().min(0).default(0)),
    timezone: z.string().max(100).optional(),
    mediaUrl: z.string().max(2048).optional(),
    mediaKey: z.string().max(500).optional(),
    mediaType: z.enum(["image", "audio"]).optional(),
    mediaMeta: z.object({
        width: optionalPositiveNumber(20_000),
        height: optionalPositiveNumber(20_000),
        size: optionalPositiveInt(12 * 1024 * 1024),
        durationMs: optionalPositiveInt(5 * 60 * 1000),
        mimeType: z.string().max(100).optional(),
        waveform: z.array(z.number().min(0).max(1)).max(48).optional(),
    }).optional(),
}).refine(data => data.content.length > 0 || (!!data.mediaKey && !!data.mediaType), {
    message: "A message must have text content or a media attachment",
});
export function createChatRouter(dependencies) {
    const router = Router({mergeParams: true});
    router.post("/", async (req, res, next) => {
        const controller = new AbortController();
        let opened = false;
        let partial = false;
        let clientDisconnected = false;
        const close = () => {
            clientDisconnected = true;
        };
        res.on("close", close);
        const emit = (event, data) => {
            if (res.destroyed || res.writableEnded) return;
            if (!opened) {
                res.set({"Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"});
                res.flushHeaders(); opened = true;
            }
            if (event === "delta" && data.content) partial = true;
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            } catch {
                // Stream closed, generation continues in background
            }
        };
        try {
            const relationshipId = new Types.ObjectId(requireObjectId(req.params.relationshipId, "relationshipId"));
            const body = chatBody.parse(req.body);
            await generateReply({
                ...dependencies,
                relationshipId,
                userId: req.auth.userId,
                body,
                signal: controller.signal,
                emit,
                isClientDisconnected: () => clientDisconnected,
            });
            if (!res.writableEnded && !res.destroyed) res.end();
        } catch (error) {
            console.error("[chat] generation failed", error?.message || error);
            if (!opened && !res.writableEnded && !res.destroyed) return next(error);
            emit("error", {code: "GENERATION_FAILED", message: partial ? "The reply was interrupted. Your partial reply was kept." : "Unable to generate a reply. You can retry.", partial});
            if (!res.writableEnded && !res.destroyed) res.end();
        } finally { res.off("close", close); }
    });
    router.post("/initiate", async (req, res) => {
        const relationshipId = new Types.ObjectId(requireObjectId(req.params.relationshipId, "relationshipId"));
        // Clients may only ask for a timed second bubble. Openers, check-ins and
        // left-on-read teasing are decided by the workers, never by the app.
        const body = z.object({
            timezone: z.string().max(100).optional(),
            triggerType: z.enum(["follow_up", "idle_nudge"]).optional(),
        }).parse(req.body || {});
        const data = await withChatLease(relationshipId, req.auth.userId, async signal => {
            const availability = await getCompanionAvailability({
                userId: req.auth.userId,
                relationshipId,
                env: dependencies.env,
            });
            if (availability.companionOffline) return null;
            return initiateScenario({
                relationshipId, userId: req.auth.userId, llm: dependencies.llm, userTimezone: body.timezone, triggerType: body.triggerType || "follow_up", signal,
            });
        });
        res.status(data ? 201 : 200).json({data, ...(data ? {} : {skipped: true})});
    });
    router.post("/generate-image", async (req, res) => {
        if (!dependencies.mediaProvider) throw new HttpError(503, "Image generation is not configured", "MEDIA_MODEL_NOT_CONFIGURED");
        const relationshipId = requireObjectId(req.params.relationshipId, "relationshipId");
        await requireOwnedRelationship(relationshipId, req.auth.userId);
        const { prompt } = z.object({prompt: z.string().trim().min(1).max(2000)}).parse(req.body);
        const generated = await dependencies.mediaProvider.generateImage({prompt, signal: AbortSignal.timeout(120_000)});
        const stored = await dependencies.storage.upload({
            buffer: generated.buffer,
            mimeType: generated.mimeType,
            folder: `messages/${relationshipId}`,
        });
        res.status(201).json({data: {...stored, model: generated.model}});
    });
    router.post("/speech/:messageId", async (req, res) => {
        if (!dependencies.mediaProvider) throw new HttpError(503, "Speech generation is not configured", "MEDIA_MODEL_NOT_CONFIGURED");
        const relationshipId = requireObjectId(req.params.relationshipId, "relationshipId");
        const messageId = requireObjectId(req.params.messageId, "messageId");
        await requireOwnedRelationship(relationshipId, req.auth.userId);
        const message = await MessageModel.findOne({_id: messageId, relationshipId, role: "assistant"});
        if (!message) throw new HttpError(404, "Assistant message not found", "NOT_FOUND");
        if (!message.content.trim()) throw new HttpError(400, "This message has no text to read", "EMPTY_MESSAGE");
        if (message.mediaMeta?.speechUrl) return res.json({data: {url: message.mediaMeta.speechUrl, key: message.mediaMeta.speechKey, cached: true}});
        const speech = await dependencies.mediaProvider.synthesize({text: message.content.slice(0, 4096), signal: AbortSignal.timeout(60_000)});
        const stored = await dependencies.storage.upload({
            buffer: speech.buffer,
            mimeType: speech.mimeType,
            folder: `messages/${relationshipId}/speech`,
        });
        message.mediaMeta = {...message.mediaMeta?.toObject?.(), speechUrl: stored.url, speechKey: stored.key, speechModel: speech.model};
        await message.save();
        res.status(201).json({data: {...stored, model: speech.model}});
    });
    return router;
}
