// Paragraph boundaries are authored by the model, never inferred from sentences
// or network chunks. Keep one logical message for retries, memory, and receipts.
export function createReplyBubbles(content, messageId) {
    const text = String(content || "").replace(/\r\n/g, "\n").trim();
    if (!text) return [];
    const parts = text.includes("```") ? [text] : text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
    const bounded = parts.length > 4 ? [...parts.slice(0, 3), parts.slice(3).join("\n\n")] : parts;
    return bounded.map((text, index) => ({ id: `${messageId}:${index}`, kind: "text", text }));
}

export function replyEnvelope(message) {
    return {
        id: String(message._id),
        content: message.content || "",
        bubbles: message.bubbles?.length ? message.bubbles : createReplyBubbles(message.content, message._id),
        status: message.status,
        ...(message.mediaUrl ? {
            mediaUrl: message.mediaUrl,
            mediaType: message.mediaType,
            mediaMeta: message.mediaMeta,
        } : {}),
    };
}
