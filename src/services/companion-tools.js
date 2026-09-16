/**
 * Maya classifies the turn by which tool she calls (or none).
 * text: no media tool
 * image sent / refused: send_photo / refuse_photo
 * audio sent / refused: send_voice_note / refuse_voice_note
 */

import { userAskedForPhoto } from "./companion-photo.service.js";
import { userAskedForVoice } from "./companion-voice.service.js";

export const COMPANION_TOOLS = [
    {
        type: "function",
        function: {
            name: "send_photo",
            strict: true,
            description:
                "Image needed and you are sending it. Attach one photo. Describe what it shows. Do not call this if you are refusing or if only text is needed.",
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
                "Image needed but you are not sending it. Call this when they asked for a picture and you are refusing. Do not call this for ordinary chat or a compliment on a photo already sent.",
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
                "Audio needed and you are sending it. Attach a voice note. Do not call this if you are refusing or if only text is needed.",
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
    let photo = null;
    let voice = null;
    for (const call of toolCalls) {
        const name = call?.function?.name || call?.name;
        const args = parseArgs(call?.function?.arguments ?? call?.arguments);
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
    return { photo, voice };
}

const PHOTO_TOOLS = COMPANION_TOOLS.filter((tool) =>
    ["send_photo", "refuse_photo"].includes(tool.function.name),
);
const VOICE_TOOLS = COMPANION_TOOLS.filter((tool) =>
    ["send_voice_note", "refuse_voice_note"].includes(tool.function.name),
);

export function toolsForCompanionTurn(userText = "") {
    const photoNeeded = userAskedForPhoto(userText);
    const voiceNeeded = userAskedForVoice(userText);
    if (photoNeeded && voiceNeeded) {
        return { tools: COMPANION_TOOLS, toolChoice: "required", photoNeeded: true, voiceNeeded: true };
    }
    if (photoNeeded) {
        return { tools: PHOTO_TOOLS, toolChoice: "required", photoNeeded: true, voiceNeeded: false };
    }
    if (voiceNeeded) {
        return { tools: VOICE_TOOLS, toolChoice: "required", photoNeeded: false, voiceNeeded: true };
    }
    return { tools: undefined, toolChoice: undefined, photoNeeded: false, voiceNeeded: false };
}
