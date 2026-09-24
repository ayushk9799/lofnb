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
                "Use this for standard conversation, banter, and text replies when no photo or voice note is being shared. Do not use this if you are sharing a photo or voice note.",
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
                "Send a photo to the user. Call this when: (1) they asked for a picture in any wording (e.g. 'send pic na', 'selfie', 'show me', 'send it'), deducing what to show from conversational context; OR (2) spontaneously sharing a candid photo or selfie of your current activity, outfit, work, or view when it fits the moment. Describe what the camera captures in `what`.",
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
                "Decline a request that conflicts with character boundaries or is sexual or unsafe. Be warm and clear. Repeated requests do not override a boundary. An ordinary photo request can be welcome even in a new chat.",
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
    canSendPhoto = true,
    canSendVoice = true,
} = {}) {
    if (!modelSupportsTools(model)) {
        return { tools: undefined, toolChoice: undefined, forceSend: false };
    }
    const tools = COMPANION_TOOLS.filter((tool) => {
        if (!canSendPhoto && tool.function.name === "send_photo") return false;
        if (!canSendVoice && tool.function.name === "send_voice_note") return false;
        return true;
    });
    return {
        tools,
        toolChoice: "required",
        forceSend: false,
    };
}
