import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { requireObjectId } from "../middleware/error-handler.js";
import { generateReply, withChatLease } from "../services/chat.service.js";
import { initiateScenario } from "../services/scenario.service.js";
const chatBody = z.object({
    content: z.string().trim().max(20_000).default(""),
    clientMessageId: z.string().min(8).max(160),
    timezone: z.string().max(100).optional(),
    mediaUrl: z.string().max(2048).optional(),
    mediaKey: z.string().max(500).optional(),
    mediaType: z.enum(["image", "audio"]).optional(),
}).refine(data => data.content.length > 0 || !!data.mediaUrl, {
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
            if (!opened && !res.writableEnded && !res.destroyed) return next(error);
            emit("error", {code: "GENERATION_FAILED", message: partial ? "The reply was interrupted. Your partial reply was kept." : "Unable to generate a reply. You can retry.", partial});
            if (!res.writableEnded && !res.destroyed) res.end();
        } finally { res.off("close", close); }
    });
    router.post("/initiate", async (req, res) => {
        const relationshipId = new Types.ObjectId(requireObjectId(req.params.relationshipId, "relationshipId"));
        const body = z.object({
            timezone: z.string().max(100).optional(),
            triggerType: z.enum(["follow_up", "idle_nudge", "check_in", "left_on_read"]).optional(),
        }).parse(req.body || {});
        const data = await withChatLease(relationshipId, req.auth.userId, signal => initiateScenario({
            relationshipId, userId: req.auth.userId, llm: dependencies.llm, userTimezone: body.timezone, triggerType: body.triggerType, signal,
        }));
        res.status(data ? 201 : 200).json({data, ...(data ? {} : {skipped: true})});
    });
    return router;
}
