/**
 * Maya reads the latest user message and classifies the turn with a tool.
 * The backend does not regex their wording to pick the tool.
 */

export const COMPANION_TOOLS = [
    {
        type: "function",
        function: {
            name: "text",
            strict: true,
            description:
                "Only text is needed this turn. Call this for ordinary chat and for a compliment on a photo already sent. Do not call this if they asked for a photo or a voice note.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "send_photo",
            strict: true,
            description:
                "They want a picture, in any wording: a pic, selfie, show me, I wanna see, send it, etc. You are sending it. Describe what it shows.",
            parameters: {
                type: "object",
                properties: {
                    what: {
                        type: "string",
                        description: "What the photo shows. A visual description, not the text of your reply.",
                    },
                },
                required: ["what"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "refuse_photo",
            strict: true,
            description:
                "Rare. Only if the ask is explicitly sexual or actually unsafe. Do not refuse because the chat is new, they are a stranger, you already said no, or they asked again.",
            parameters: {
                type: "object",
                properties: {
                    reason: {
                        type: "string",
                        description: "Why you are not sending, in your voice.",
                    },
                },
                required: ["reason"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "send_voice_note",
            strict: true,
            description:
                "They want to hear you, in any wording: voice note, audio, record something, say it out loud. Attach a voice note. Never answer that with a photo.",
            parameters: {
                type: "object",
                properties: {
                    spoken: {
                        type: "string",
                        description: "What you say out loud. Casual, not a reading of the text.",
                    },
                },
                required: ["spoken"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "refuse_voice_note",
            strict: true,
            description:
                "Audio needed but you are not sending it. Call this when they asked for a voice note and you are refusing.",
            parameters: {
                type: "object",
                properties: {
                    reason: {
                        type: "string",
                        description: "Why you are not sending, in your voice.",
                    },
                },
                required: ["reason"],
                additionalProperties: false,
            },
        },
    },
];

function parseArgs(raw) {
    if (raw && typeof raw === "object") return raw;
    const text = String(raw || "").trim();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

export function intentsFromToolCalls(toolCalls = []) {
    let text = false;
    let photo = null;
    let voice = null;
    for (const call of toolCalls) {
        const name = call?.function?.name || call?.name;
        const args = parseArgs(call?.function?.arguments ?? call?.arguments);
        if (name === "text") text = true;
        if (name === "send_photo") {
            const what = String(args.what || args.query || args.scene || "").trim();
            if (what) photo = { action: "send", query: what };
        }
        if (name === "refuse_photo") {
            if (photo?.action === "send") continue;
            const reason = String(args.reason || "").trim();
            photo = { action: "refuse", reason };
        }
        if (name === "send_voice_note") {
            const spoken = String(args.spoken || "").trim();
            if (spoken) voice = { action: "send", spoken };
        }
        if (name === "refuse_voice_note") {
            if (voice?.action === "send") continue;
            const reason = String(args.reason || "").trim();
            voice = { action: "refuse", reason };
        }
    }
    if (photo || voice) text = false;
    return { text, photo, voice };
}

export function modelSupportsTools(model = "") {
    return !/mythomax/i.test(String(model || ""));
}

export function toolsForCompanionTurn(_userText = "", {
    model,
    priorPhotoRefusals = 0,
    canSendPhoto = true,
} = {}) {
    if (!modelSupportsTools(model)) {
        return { tools: undefined, toolChoice: undefined, forceSend: false };
    }
    const tools = canSendPhoto
        ? COMPANION_TOOLS
        : COMPANION_TOOLS.filter((tool) => tool.function.name !== "send_photo");
    return {
        tools,
        toolChoice: "required",
        forceSend: canSendPhoto && priorPhotoRefusals > 0,
    };
}
