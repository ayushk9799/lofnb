import { randomUUID } from "node:crypto";
import { RelationshipModel } from "../models/relationship.model.js";
import { MessageModel } from "../models/message.model.js";
import { MemoryJobModel } from "../models/memory-job.model.js";
import { requireOwnedRelationship } from "./relationship.service.js";
import { allocateMessageSequence } from "./sequence.service.js";
import { assembleContext, ensureProfileMemory } from "./context.service.js";
import { attachCompanionPhoto, canAffordPhoto, extractPhotoIntent } from "./companion-photo.service.js";
import { createReplyBubbles, replyEnvelope } from "./reply-bubbles.service.js";
import { attachCompanionVoice, canAffordVoice, extractVoiceIntent } from "./companion-voice.service.js";
import { resolveCompanionMedia } from "./companion-media.service.js";
import { intentsFromToolCalls, toolsForCompanionTurn } from "./companion-tools.js";
import { HttpError } from "../utils/http-error.js";
import { sendChatPushNotification } from "./push-notification.service.js";
import { assertCompanionOnline, getCompanionAvailability } from "./chat-quota.service.js";

export async function withChatLease(relationshipId, userId, work) {
    await requireOwnedRelationship(relationshipId, userId);
    const token = randomUUID();
    const relationship = await RelationshipModel.findOneAndUpdate({
        _id: relationshipId, userId,
        $or: [{"chatLease.expiresAt": {$lte: new Date()}}, {"chatLease.expiresAt": {$exists: false}}],
    }, {$set: {chatLease: {token, expiresAt: new Date(Date.now() + 120_000)}}});
    if (!relationship) throw new HttpError(409, "A reply is already in progress. Please retry shortly.", "CHAT_BUSY");
    try {
        // An expired lease means the prior process could not finish this turn.
        await MessageModel.updateMany({relationshipId, status: "streaming"}, [{$set: {
            status: {$cond: [{$ne: ["$content", ""]}, "partial", "failed"]}, completedAt: new Date(),
        }}]);
        return await work(AbortSignal.timeout(90_000));
    } finally {
        await RelationshipModel.updateOne({_id: relationshipId, "chatLease.token": token}, {$unset: {chatLease: 1}})
            .catch(() => console.warn("Chat lease will expire automatically"));
    }
}

export async function enqueueMemory(message) {
    await MemoryJobModel.updateOne({assistantMessageId: message._id}, {$setOnInsert: {
        relationshipId: message.relationshipId, userMessageId: message.replyToMessageId,
        assistantMessageId: message._id, status: "pending", availableAt: new Date(),
    }}, {upsert: true});
    await MessageModel.updateOne({_id: message._id}, {$set: {memoryPending: false}});
}

/**
 * Transcribes a voice note and maps every failure mode to an HttpError the
 * client can show, instead of a generic 500.
 */
export async function transcribeVoiceNote({mediaProvider, media, mediaKey, signal}) {
    let transcript;
    try {
        transcript = await mediaProvider.transcribe({...media, signal});
    } catch (error) {
        if (signal?.aborted) throw error;
        console.error("[chat] voice note transcription failed", {
            mediaKey, mimeType: media.mimeType, bytes: media.buffer?.length,
            error: error.message, attempts: error.attempts,
        });
        throw new HttpError(502, "Lofn couldn't process that voice note right now. Please try sending it again.", "TRANSCRIPTION_FAILED");
    }
    const text = String(transcript?.text || "").trim();
    if (!text) {
        console.warn("[chat] voice note contained no speech", {
            mediaKey, mimeType: media.mimeType, bytes: media.buffer?.length, attempts: transcript?.attempts,
        });
        throw new HttpError(422, "We couldn't hear anything in that voice note. Try recording again, a little closer to the mic.", "EMPTY_VOICE_NOTE");
    }
    return {...transcript, text};
}

function toolFollowUpContent(name, { canSendPhoto = true, canSendVoice = true } = {}) {
    if (name === "send_photo" && !canSendPhoto) {
        return "You are not sending a photo. Write the no in the bubble. Do not mention tools.";
    }
    if (name === "send_photo") return "Photo will attach. Write the chat bubble like you dropped it. Do not mention tools.";
    if (name === "refuse_photo") return "You are not sending a photo. Write the no in the bubble. Do not mention tools.";
    if (name === "send_voice_note" && !canSendVoice) {
        return "You are not sending a voice note. Write the no in the bubble. Do not mention tools.";
    }
    if (name === "send_voice_note") return "Voice note will attach. Write a short bubble. Do not mention tools.";
    if (name === "refuse_voice_note") return "You are not sending a voice note. Write the no in the bubble. Do not mention tools.";
    return "This turn is text only. Write the chat bubble. Do not mention tools.";
}

function toolFollowUpMessages(toolCalls = [], { canSendPhoto = true, canSendVoice = true } = {}) {
    const calls = toolCalls.map((call, index) => {
        const args = call?.function?.arguments ?? call?.arguments ?? "{}";
        return {
            id: call?.id || `call_${index + 1}`,
            type: "function",
            function: {
                name: call?.function?.name || call?.name || "",
                arguments: typeof args === "string" ? args : JSON.stringify(args || {}),
            },
        };
    }).filter((call) => call.function.name);
    return [
        { role: "assistant", content: null, tool_calls: calls },
        ...calls.map((call) => ({
            role: "tool",
            tool_call_id: call.id,
            content: toolFollowUpContent(call.function.name, { canSendPhoto, canSendVoice }),
        })),
    ];
}

export async function generateReply({relationshipId, userId, body, env, llm, visionLlm, mediaProvider, storage, embeddingProvider, signal, emit}) {
    if (!llm) throw new HttpError(503, "The LLM provider is not configured", "LLM_NOT_CONFIGURED");
    return withChatLease(relationshipId, userId, async timeout => {
        const generationSignal = AbortSignal.any([timeout, signal]);
        let user = await MessageModel.findOne({relationshipId, clientMessageId: body.clientMessageId});
        const mediaKeyMismatch = (user?.mediaKey || "") !== (body.mediaKey || "");
        const contentMismatch = body.mediaType === "audio"
            ? Boolean(body.content && user?.content !== body.content && !user?.content?.startsWith(body.content))
            : user?.content !== body.content;
        if (user && (user.role !== "user" || mediaKeyMismatch || contentMismatch)) {
            throw new HttpError(409, "Retry content must match the original message", "MESSAGE_CONFLICT");
        }
        let selectedLlm = llm;
        let currentMessage = body.content;
        let currentMedia;
        let mediaMeta = body.mediaMeta || {};
        if (body.mediaKey) {
            const expectedPrefix = `messages/${relationshipId}/`;
            if (!body.mediaKey.startsWith(expectedPrefix)) {
                throw new HttpError(400, "Invalid message media", "INVALID_MEDIA_KEY");
            }
            if (!storage) throw new HttpError(503, "Media storage is unavailable", "STORAGE_UNAVAILABLE");
            const media = await storage.readBuffer(body.mediaKey);
            if (body.mediaType === "audio") {
                if (!media.mimeType?.startsWith("audio/")) throw new HttpError(400, "Choose an audio file", "INVALID_FILE_TYPE");
                if (!user) {
                    if (!mediaProvider) throw new HttpError(503, "Audio transcription is not configured", "MEDIA_MODEL_NOT_CONFIGURED");
                    const transcript = await transcribeVoiceNote({mediaProvider, media, mediaKey: body.mediaKey, signal: generationSignal});
                    mediaMeta = {...mediaMeta, mimeType: media.mimeType, transcript: transcript.text, transcriptModel: transcript.model};
                    currentMessage = body.content
                        ? `${body.content}\n\n[Voice message transcript: ${transcript.text}]`
                        : transcript.text;
                } else {
                    const transcript = user.mediaMeta?.transcript || user.content;
                    currentMessage = body.content
                        ? `${body.content}\n\n[Voice message transcript: ${transcript}]`
                        : transcript;
                }
            } else if (body.mediaType === "image") {
                if (!media.mimeType?.startsWith("image/")) throw new HttpError(400, "Choose an image file", "INVALID_FILE_TYPE");
                if (!visionLlm) throw new HttpError(503, "Image understanding is not configured", "MEDIA_MODEL_NOT_CONFIGURED");
                selectedLlm = visionLlm;
                currentMessage = body.content || "[The user sent an image. React naturally to what you can see.]";
                currentMedia = {mimeType: media.mimeType, data: media.buffer.toString("base64")};
                mediaMeta = {...mediaMeta, mimeType: media.mimeType};
            }
        }
        if (!user) {
            await assertCompanionOnline({ userId, relationshipId, env });
            user = await MessageModel.create({
                relationshipId, sequenceNumber: await allocateMessageSequence(relationshipId, userId),
                role: "user", content: body.mediaType === "audio" ? (body.content || mediaMeta.transcript) : body.content,
                status: "completed", clientMessageId: body.clientMessageId, completedAt: new Date(),
                mediaUrl: body.mediaUrl, mediaKey: body.mediaKey, mediaType: body.mediaType, mediaMeta,
            });
            await getCompanionAvailability({ userId, relationshipId, env }).catch(() => {});
        }
        const seenAt = new Date();
        if (!user.readAt) {
            user.readAt = seenAt;
            await MessageModel.updateOne({ _id: user._id }, { $set: { readAt: seenAt } });
        }
        await RelationshipModel.findByIdAndUpdate(relationshipId, {
            $max: { companionLastReadSequence: user.sequenceNumber },
            $set: { companionLastReadAt: seenAt },
        });

        let assistant = await MessageModel.findOne({relationshipId, replyToMessageId: user._id});
        if (assistant && ["completed", "partial"].includes(assistant.status)) {
            emit("seen", { userMessageId: user._id, userSequence: user.sequenceNumber, seenAt: seenAt.toISOString() });
            emit("message", {id: assistant._id, userId: user._id, userSequence: user.sequenceNumber, sequenceNumber: assistant.sequenceNumber});
            const bubbles = assistant.bubbles?.length ? assistant.bubbles : createReplyBubbles(assistant.content, assistant._id);
            for (let i = 0; i < bubbles.length; i++) {
                const b = bubbles[i];
                emit("bubble_start", { bubbleIndex: i, id: b.id });
                emit("delta", { content: b.text, bubbleIndex: i });
                emit("bubble_end", { bubbleIndex: i, id: b.id, text: b.text });
            }
            emit("reply", replyEnvelope(assistant));
            emit("done", {cached: true, status: assistant.status});
            return;
        }
        // Failed empty replies can be regenerated with the same request ID, without a second user message.
        if (assistant) {
            assistant.status = "streaming";
            assistant.content = "";
            assistant.bubbles = undefined;
            await assistant.save();
        } else assistant = await MessageModel.create({
            relationshipId, sequenceNumber: await allocateMessageSequence(relationshipId, userId),
            role: "assistant", status: "streaming", replyToMessageId: user._id,
            generation: {provider: selectedLlm.name, model: selectedLlm.model},
        });
        let content = "";
        let rawContent = "";
        const startedAt = Date.now();
        let lastPersisted = startedAt;
        try {
            generationSignal.throwIfAborted();
            await ensureProfileMemory({ relationshipId, userId, llm, signal: generationSignal });
            const context = await assembleContext({relationshipId, userId,
                currentSequence: user.sequenceNumber, currentMessage, currentMedia,
                embeddingProvider, vectorEnabled: env.MEMORY_VECTOR_SEARCH_ENABLED,
                vectorIndexName: env.MEMORY_VECTOR_INDEX, userTimezone: body.timezone, signal: generationSignal,
                vectorMinScore: env.MEMORY_VECTOR_MIN_SCORE,
            });
            generationSignal.throwIfAborted();
            emit("seen", { userMessageId: user._id, userSequence: user.sequenceNumber, seenAt: seenAt.toISOString() });
            emit("message", {id: assistant._id, userId: user._id, userSequence: user.sequenceNumber, sequenceNumber: assistant.sequenceNumber});
            let toolCalls = [];
            const canSendPhoto = canAffordPhoto(body.clientGems);
            const canSendVoice = canAffordVoice(body.clientGems);
            const mediaTurn = toolsForCompanionTurn(currentMessage, {
                model: selectedLlm.model,
                canSendPhoto,
                canSendVoice,
            });
            const consume = async (stream) => {
                for await (const chunk of stream) {
                    generationSignal.throwIfAborted();
                    if (chunk && typeof chunk === "object" && Array.isArray(chunk.toolCalls)) {
                        if (!toolCalls.length) toolCalls = chunk.toolCalls;
                        continue;
                    }
                    const text = typeof chunk === "string" ? chunk : "";
                    if (!text) continue;
                    rawContent += text;
                    if (rawContent.length > 100_000) throw new Error("Reply is too long");
                    if (Date.now() - lastPersisted > 1000) {
                        await MessageModel.updateOne({_id: assistant._id, status: "streaming"}, {$set: {content: rawContent}});
                        lastPersisted = Date.now();
                    }
                }
            };
            await consume(selectedLlm.streamChat({
                messages: context.messages,
                tools: mediaTurn.tools,
                toolChoice: mediaTurn.toolChoice,
                signal: generationSignal,
            }));
            if (!rawContent.trim() && toolCalls.length) {
                await consume(selectedLlm.streamChat({
                    messages: [...context.messages, ...toolFollowUpMessages(toolCalls, { canSendPhoto, canSendVoice })],
                    signal: generationSignal,
                }));
            }
            generationSignal.throwIfAborted();
            const fromTools = intentsFromToolCalls(toolCalls);
            const taggedPhoto = extractPhotoIntent(rawContent);
            content = extractVoiceIntent(taggedPhoto.content).content
                .replace(/\s*\[(?:sent|refused) a (?:photo|picture|voice note)\]/gi, "")
                .trim();
            const resolved = resolveCompanionMedia({
                toolPhoto: fromTools.photo || taggedPhoto.intent,
                toolVoice: fromTools.voice,
                toolText: fromTools.text,
                userText: currentMessage,
                replyText: content,
                forceSend: mediaTurn.forceSend,
                canSendPhoto,
                canSendVoice,
            });
            const photoIntent = resolved.photo;
            const voiceIntent = resolved.voice;
            if (!content.trim() && fromTools.photo?.action === "refuse" && !mediaTurn.forceSend) {
                content = fromTools.photo.reason || "not sending one.";
            } else if (!content.trim() && !canSendPhoto && fromTools.photo?.action === "send") {
                content = "not sending one.";
            } else if (!content.trim() && fromTools.voice?.action === "refuse") {
                content = fromTools.voice.reason || "not sending a voice note.";
            } else if (!content.trim() && !canSendVoice && fromTools.voice?.action === "send") {
                content = "not sending a voice note.";
            }
            if (!content.trim() && !voiceIntent && !photoIntent) {
                throw new Error("The model returned an empty response");
            }
            const bubbles = createReplyBubbles(content, assistant._id);
            const generationFields = {
                content, status: "completed", completedAt: new Date(), memoryPending: true,
                bubbles,
                "generation.latencyMs": Date.now() - startedAt, "generation.retrievedMemoryIds": context.retrievedMemoryIds,
                "generation.mediaDecision": resolved.decision,
            };
            if (!canSendPhoto && resolved.decision === "image_refused") {
                generationFields["generation.mediaRefuseReason"] = "insufficient_gems";
            }
            if (!canSendVoice && resolved.decision === "audio_refused") {
                generationFields["generation.mediaRefuseReason"] = "insufficient_gems";
            }

            const isTest = process.env.NODE_ENV === "test";
            const interBubbleDelay = isTest
                ? 0
                : (env?.INTER_BUBBLE_DELAY_MS !== undefined ? Number(env.INTER_BUBBLE_DELAY_MS) : 1000);
            const tickDelay = isTest ? 0 : 20;

            for (let i = 0; i < bubbles.length; i++) {
                const bubble = bubbles[i];
                generationSignal.throwIfAborted();
                emit("bubble_start", { bubbleIndex: i, id: bubble.id });

                if (tickDelay > 0 && bubble.text.length > 20) {
                    const words = bubble.text.split(" ");
                    for (let w = 0; w < words.length; w++) {
                        const wordChunk = (w === 0 ? "" : " ") + words[w];
                        emit("delta", { content: wordChunk, bubbleIndex: i });
                        await new Promise(r => setTimeout(r, tickDelay));
                    }
                } else {
                    emit("delta", { content: bubble.text, bubbleIndex: i });
                }

                emit("bubble_end", { bubbleIndex: i, id: bubble.id, text: bubble.text });

                // If another bubble follows, pause and emit typing indicator without ending the stream
                if (i < bubbles.length - 1) {
                    emit("typing", { isTyping: true, nextBubbleIndex: i + 1, delayMs: interBubbleDelay });
                    if (interBubbleDelay > 0) {
                        await new Promise(r => setTimeout(r, interBubbleDelay));
                    }
                    emit("typing", { isTyping: false, nextBubbleIndex: i + 1 });
                }
            }

            const saved = await MessageModel.updateOne({_id: assistant._id, status: "streaming"}, {$set: generationFields});
            if (!saved.modifiedCount) throw new Error("Reply lease expired");
            if (voiceIntent && !photoIntent) {
                const voiceResult = await attachCompanionVoice({
                    relationshipId, assistantMessage: assistant,
                    replyText: content, intent: voiceIntent, mediaProvider, storage,
                });
                if (voiceResult?.url) {
                    generationFields.mediaUrl = voiceResult.url;
                    generationFields.mediaType = "audio";
                    if (voiceResult.key) generationFields.mediaKey = voiceResult.key;
                }
            } else if (photoIntent) {
                const photoResult = await attachCompanionPhoto({
                    relationshipId, assistantMessage: assistant, intent: photoIntent, mediaProvider, storage,
                    skipImageGeneration: env?.ENABLE_IMAGE_GENERATION !== undefined
                        ? !env.ENABLE_IMAGE_GENERATION
                        : env?.NODE_ENV === "development",
                });
                if (photoResult?.url || photoResult?.mediaUrl) {
                    generationFields.mediaUrl = photoResult.url || photoResult.mediaUrl;
                    generationFields.mediaType = photoResult.mediaType || "image";
                    generationFields.mediaMeta = photoResult.mediaMeta;
                    if (photoResult.key || photoResult.mediaKey) {
                        generationFields.mediaKey = photoResult.key || photoResult.mediaKey;
                    }
                }
            }
            // The completed message is the durable outbox. A worker recovers a failed enqueue.
            await enqueueMemory(assistant).catch(() => console.warn("Memory scheduling deferred to recovery"));
            emit("reply", replyEnvelope({_id: assistant._id, ...generationFields}));
            emit("done", {status: "completed"});

            // Dispatch push notification for completed reply
            try {
                const rel = await RelationshipModel.findById(relationshipId).populate("characterId").lean();
                const charName = rel?.characterId?.name || "Companion";
                const charAvatar = rel?.characterId?.avatarUrl || "";
                sendChatPushNotification({
                    userId,
                    characterName: charName,
                    content,
                    relationshipId,
                    avatarUrl: charAvatar,
                    extraData: { sequenceNumber: assistant.sequenceNumber },
                }).catch(err => console.warn("[Push] Error dispatching push:", err.message));
            } catch (err) {
                console.warn("[Push] Error checking relationship for push:", err.message);
            }
        } catch (error) {
            const partialText = (rawContent || content).slice(0, 100_000);
            await MessageModel.updateOne({_id: assistant._id, status: "streaming"}, {$set: {
                content: partialText, status: partialText ? "partial" : "failed", completedAt: new Date(),
                bubbles: createReplyBubbles(partialText, assistant._id),
            }}).catch(() => console.warn("Interrupted reply will be recovered after lease expiry"));
            throw error;
        }
    });
}
