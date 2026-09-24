import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { CharacterModel } from "../src/models/character.model.js";
import { RelationshipModel } from "../src/models/relationship.model.js";
import { MessageModel } from "../src/models/message.model.js";
import { MemoryModel } from "../src/models/memory.model.js";
import { MemoryJobModel } from "../src/models/memory-job.model.js";
import { generateReply } from "../src/services/chat.service.js";
import { initiateScenario } from "../src/services/scenario.service.js";
import { extractAndStoreMemory } from "../src/services/memory-extraction.service.js";
import {
  recoverChatWork,
  startMemoryWorker,
} from "../src/workers/memory.worker.js";
const models = [
  CharacterModel,
  RelationshipModel,
  MessageModel,
  MemoryModel,
  MemoryJobModel,
];
const env = {
  NODE_ENV: "test",
  ALLOW_DEV_AUTH: true,
  CORS_ORIGIN: "http://localhost:5173",
  MEMORY_VECTOR_SEARCH_ENABLED: false,
};
let database, character, relationship;
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all(models.map((model) => model.init()));
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  await Promise.all(models.map((model) => model.deleteMany({})));
  character = await CharacterModel.create({
    slug: "robin",
    name: "Robin",
    age: 44,
    persona: { summary: "Architect" },
    backstory: { summary: "Lives in London" },
    gallery: [{ url: "https://example.com/photo.png", caption: "Original" }],
  });
  relationship = await RelationshipModel.create({
    userId: "alice",
    characterId: character._id,
  });
});
afterEach(() => vi.restoreAllMocks());
const llm = {
  name: "fake",
  model: "fake",
  async *streamChat() {
    yield "hello";
  },
  async generateText() {
    return "hey there";
  },
};
function reply(overrides = {}) {
  const { body, ...rest } = overrides;
  return generateReply({
    relationshipId: relationship._id,
    userId: "alice",
    env,
    llm,
    signal: new AbortController().signal,
    emit: () => {},
    ...rest,
    body: { content: "hello", clientMessageId: "request-001", clientGems: 99, ...body },
  });
}
async function source() {
  await reply();
  const user = await MessageModel.findOne({ role: "user" });
  const assistant = await MessageModel.findOne({ role: "assistant" });
  return {
    relationshipId: relationship._id,
    userMessageId: user._id,
    assistantMessageId: assistant._id,
  };
}
const extracted = {
  memories: [
    {
      type: "user_fact",
      key: "user_pet",
      text: "Has a cat",
      confidence: 0.9,
      importance: 0.8,
    },
  ],
  relationshipSummary: "They discussed pets",
  mood: "happy",
};

it("persists and replays a coherent multi-bubble turn exactly once", async () => {
  const events = [];
  const multiLlm = {...llm, async *streamChat() { yield "hey :)\n"; yield "\ni'm making dinner"; yield "\n\nwhat are you up to?"; }};
  await reply({llm: multiLlm, emit: (event, data) => events.push({event, data})});
  const saved = await MessageModel.findOne({role: "assistant"}).lean();
  expect(saved.bubbles.map(b => b.text)).toEqual(["hey :)", "i'm making dinner", "what are you up to?"]);
  expect(events.find(e => e.event === "reply").data.bubbles).toEqual(saved.bubbles);

  // Verify server-side bubble stream lifecycle
  const bubbleStarts = events.filter(e => e.event === "bubble_start");
  const bubbleEnds = events.filter(e => e.event === "bubble_end");
  expect(bubbleStarts).toHaveLength(3);
  expect(bubbleEnds).toHaveLength(3);
  expect(bubbleStarts.map(e => e.data.bubbleIndex)).toEqual([0, 1, 2]);
  expect(bubbleEnds.map(e => e.data.bubbleIndex)).toEqual([0, 1, 2]);

  // Ensure stream connection was kept open: done event must only appear AFTER the last bubble
  const doneIndex = events.findIndex(e => e.event === "done");
  const lastBubbleEndIndex = events.findLastIndex(e => e.event === "bubble_end");
  expect(doneIndex).toBeGreaterThan(lastBubbleEndIndex);
  expect(events.filter(e => e.event === "done")).toHaveLength(1);

  const replay = [];
  await reply({llm: {...llm, streamChat: () => {throw new Error("must not regenerate");}}, emit: (event, data) => replay.push({event, data})});
  expect(replay.find(e => e.event === "reply").data.bubbles.map(b => b.id)).toEqual(saved.bubbles.map(b => b.id));
  expect(await MessageModel.countDocuments({role: "assistant"})).toBe(1);
  expect(await MemoryJobModel.countDocuments()).toBe(1);
});

it("retains partial bubbles if the stream fails and replays without making up a tail", async () => {
  await expect(reply({llm: {...llm, async *streamChat() {yield "hey\n\nsecond thought"; throw new Error("stream failed");}}})).rejects.toThrow("stream failed");
  const saved = await MessageModel.findOne({role: "assistant"}).lean();
  expect(saved.status).toBe("partial");
  expect(saved.bubbles.map(b => b.text)).toEqual(["hey", "second thought"]);
  expect(await MemoryJobModel.countDocuments()).toBe(0);
  await reply();
  expect(await MessageModel.countDocuments({role: "assistant"})).toBe(1);
});

it("extracts initiated character events without inventing a user message", async () => {
  const saved = await initiateScenario({relationshipId: relationship._id, userId: "alice", triggerType: "opener", llm: {...llm, generateText: async () => "hey :)\n\nI'm making pasta."}});
  const job = await MemoryJobModel.findOne({assistantMessageId: saved._id});
  expect(job.userMessageId).toBeUndefined();
  await extractAndStoreMemory({relationshipId: relationship._id, assistantMessageId: saved._id, llm: {generateJson: async () => ({
    memories: [{type: "user_fact", key: "user_job", text: "Chef", confidence: 1, importance: 1}], mood: "happy",
    conversationUpdate: {activeThread: "dinner", assistantEvidence: "I'm making pasta.", familiarity: "familiar", scene: {description: "Making pasta", status: "active", evidence: "I'm making pasta."}},
  })}});
  const rel = await RelationshipModel.findById(relationship._id).lean();
  expect(rel.conversationState.scene.description).toBe("Making pasta");
  expect(rel.conversationState.familiarity).toBe("unfamiliar");
  expect(await MemoryModel.countDocuments({type: "user_fact"})).toBe(0);
  expect(await MessageModel.countDocuments({role: "user"})).toBe(0);
});

it("does not send a stale initiation after another turn has arrived", async () => {
  await reply();
  const generateText = vi.fn();
  const saved = await initiateScenario({relationshipId: relationship._id, userId: "alice", triggerType: "callback", expectedSequence: -1, llm: {...llm, generateText}});
  expect(saved).toBeNull();
  expect(generateText).not.toHaveBeenCalled();
});

it("serializes concurrent turns, replays retries, and rejects changed content", async () => {
  let release, started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = reply({
    llm: {
      ...llm,
      async *streamChat() {
        started();
        await gate;
        yield "hello";
      },
    },
  });
  await waiting;
  await expect(reply()).rejects.toMatchObject({ code: "CHAT_BUSY" });
  release();
  await first;
  const events = [];
  await reply({ emit: (event, data) => events.push([event, data]) });
  expect(events.at(-1)[1].cached).toBe(true);
  expect(await MessageModel.countDocuments()).toBe(2);
  expect(await MemoryJobModel.countDocuments()).toBe(1);
  await expect(
    reply({ body: { content: "different", clientMessageId: "request-001" } }),
  ).rejects.toMatchObject({ code: "MESSAGE_CONFLICT" });
});
it("retains completed replies if job scheduling fails, then recovers the outbox", async () => {
  const mock = vi
    .spyOn(MemoryJobModel, "updateOne")
    .mockRejectedValueOnce(new Error("database unavailable"));
  await reply();
  expect(await MessageModel.findOne({ role: "assistant" })).toMatchObject({
    status: "completed",
    memoryPending: true,
  });
  mock.mockRestore();
  await recoverChatWork();
  expect(await MemoryJobModel.countDocuments()).toBe(1);
  expect(await MessageModel.findOne({ role: "assistant" })).toMatchObject({
    memoryPending: false,
    status: "completed",
  });
});
it("keeps partial text and does not extract memories from an interrupted reply", async () => {
  await expect(
    reply({
      llm: {
        ...llm,
        async *streamChat() {
          yield "part";
          throw new Error("disconnected");
        },
      },
    }),
  ).rejects.toThrow();
  expect(await MessageModel.findOne({ role: "assistant" })).toMatchObject({
    content: "part",
    status: "partial",
  });
  expect(await MemoryJobModel.countDocuments()).toBe(0);
});
it("retries a failed empty reply without duplicating the user message", async () => {
  await expect(
    reply({
      llm: {
        ...llm,
        async *streamChat() {
          yield "";
          throw new Error("unavailable");
        },
      },
    }),
  ).rejects.toThrow();
  await reply();
  expect(await MessageModel.countDocuments()).toBe(2);
  expect(await MessageModel.findOne({ role: "assistant" })).toMatchObject({
    status: "completed",
  });
});
it("attaches a generated photo when the model tags a scene, and strips the tag", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const generateImage = vi.fn(async () => ({
    buffer: png,
    mimeType: "image/png",
    model: "test-image",
  }));
  const upload = vi.fn(async () => ({
    url: "/api/storage/messages/rel/table.png",
    key: "messages/rel/table.png",
    mimeType: "image/png",
    size: 12,
  }));
  await reply({
    llm: {
      ...llm,
      async *streamChat() {
        yield "this one's from the shop.";
        yield {
          toolCalls: [{
            function: {
              name: "send_photo",
              arguments: JSON.stringify({ what: "walnut table being sanded in the shop" }),
            },
          }],
        };
      },
    },
    mediaProvider: { generateImage },
    storage: { upload },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.content).toBe("this one's from the shop.");
  expect(assistant.mediaType).toBe("image");
  expect(assistant.mediaUrl).toBe("/api/storage/messages/rel/table.png");
  expect(assistant.mediaMeta.source).toBe("generated");
  expect(generateImage).toHaveBeenCalledOnce();
  expect(upload).toHaveBeenCalledOnce();
});
it("skips image generation in development and still locks a camera-roll photo", async () => {
  const generateImage = vi.fn();
  await reply({
    env: { ...env, NODE_ENV: "development" },
    body: {
      content: "send a pic of the stoop",
      clientMessageId: "dev-skip-gen",
      clientGems: 99,
    },
    llm: {
      ...llm,
      async *streamChat() {
        yield "here.";
        yield {
          toolCalls: [{
            function: {
              name: "send_photo",
              arguments: JSON.stringify({ what: "stoop at dusk with no matching caption" }),
            },
          }],
        };
      },
    },
    mediaProvider: { generateImage },
    storage: { upload: vi.fn() },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(generateImage).not.toHaveBeenCalled();
  expect(assistant.mediaType).toBe("image");
  expect(assistant.mediaUrl).toBe("https://example.com/photo.png");
  expect(assistant.mediaMeta.locked).toBe(true);
  expect(assistant.mediaMeta.unlockCost).toBe(99);
  expect(assistant.mediaMeta.source).toBe("generated");
});
it("reuses a gallery photo instead of generating when the description matches a caption", async () => {
  const generateImage = vi.fn();
  await reply({
    llm: {
      ...llm,
      async *streamChat() {
        yield "that's the one from last week.";
        yield {
          toolCalls: [{
            function: {
              name: "send_photo",
              arguments: JSON.stringify({ what: "Original" }),
            },
          }],
        };
      },
    },
    mediaProvider: { generateImage },
    storage: { upload: vi.fn() },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.content).toBe("that's the one from last week.");
  expect(assistant.mediaType).toBe("image");
  expect(assistant.mediaUrl).toBe("https://example.com/photo.png");
  expect(assistant.mediaMeta.source).toBe("gallery");
  expect(assistant.mediaMeta.locked).toBe(true);
  expect(assistant.mediaMeta.unlockCost).toBe(99);
  expect(generateImage).not.toHaveBeenCalled();
});
it("does not generate a photo when the client has fewer than 99 hearts", async () => {
  const generateImage = vi.fn();
  const upload = vi.fn();
  await reply({
    body: { content: "send a pic", clientMessageId: "broke-photo", clientGems: 98 },
    llm: {
      ...llm,
      async *streamChat() {
        yield "this one's from last week.";
        yield {
          toolCalls: [{
            function: {
              name: "send_photo",
              arguments: JSON.stringify({ what: "stoop at dusk" }),
            },
          }],
        };
      },
    },
    mediaProvider: { generateImage },
    storage: { upload },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.mediaType).toBeUndefined();
  expect(assistant.mediaUrl).toBeUndefined();
  expect(assistant.generation.mediaDecision).toBe("image_refused");
  expect(assistant.generation.mediaRefuseReason).toBe("insufficient_gems");
  expect(generateImage).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
});
it("does not force-send a photo after refusals when hearts are below 99", async () => {
  await MessageModel.create({
    relationshipId: relationship._id,
    sequenceNumber: await (await import("../src/services/sequence.service.js")).allocateMessageSequence(relationship._id, "alice"),
    role: "assistant",
    content: "nah not sending one.",
    status: "completed",
    generation: { mediaDecision: "image_refused" },
    completedAt: new Date(),
  });
  const generateImage = vi.fn();
  await reply({
    body: { content: "please send it", clientMessageId: "still-broke", clientGems: 0 },
    llm: {
      ...llm,
      async *streamChat() {
        yield "still no.";
        yield {
          toolCalls: [{
            function: {
              name: "refuse_photo",
              arguments: JSON.stringify({ reason: "still no" }),
            },
          }],
        };
      },
    },
    mediaProvider: { generateImage },
    storage: { upload: vi.fn() },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).sort({ sequenceNumber: -1 }).lean();
  expect(assistant.generation.mediaDecision).toBe("image_refused");
  expect(assistant.mediaUrl).toBeFalsy();
  expect(generateImage).not.toHaveBeenCalled();
});
it("attaches a photo from a send_photo tool call instead of markup", async () => {
  const generateImage = vi.fn(async () => ({
    buffer: Buffer.from("iVBORw0KGgo=", "base64"),
    mimeType: "image/png",
    model: "test-image",
  }));
  const upload = vi.fn(async () => ({
    url: "/api/storage/messages/rel/park.png",
    key: "messages/rel/park.png",
    mimeType: "image/png",
    size: 12,
  }));
  await reply({
    llm: {
      ...llm,
      async *streamChat() {
        yield "this one from last week.";
        yield {
          toolCalls: [{
            function: {
              name: "send_photo",
              arguments: JSON.stringify({
                what: "park path at golden hour",
              }),
            },
          }],
        };
      },
    },
    mediaProvider: { generateImage },
    storage: { upload },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.content).toBe("this one from last week.");
  expect(assistant.mediaType).toBe("image");
  expect(assistant.mediaMeta.source).toBe("generated");
  expect(assistant.generation.mediaDecision).toBe("image_sent");
  expect(generateImage).toHaveBeenCalledOnce();
  expect(generateImage.mock.calls[0][0].prompt).toContain("park path at golden hour");
});
it("does not attach a photo when she called refuse_photo", async () => {
  const generateImage = vi.fn(async () => ({
    buffer: Buffer.from("iVBORw0KGgo=", "base64"),
    mimeType: "image/png",
    model: "test-image",
  }));
  await reply({
    body: { content: "can I see you", clientMessageId: "refuse-photo" },
    llm: {
      ...llm,
      async *streamChat() {
        yield "nah not sending pics to strangers just yet.";
        yield {
          toolCalls: [{
            function: {
              name: "refuse_photo",
              arguments: JSON.stringify({ reason: "don't send pics to strangers" }),
            },
          }],
        };
      },
    },
    mediaProvider: { generateImage },
    storage: { upload: vi.fn() },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.content).toBe("nah not sending pics to strangers just yet.");
  expect(assistant.mediaType).toBeUndefined();
  expect(assistant.generation.mediaDecision).toBe("image_refused");
  expect(generateImage).not.toHaveBeenCalled();
});
it("attaches a photo when they asked and she skipped refuse_photo", async () => {
  const generateImage = vi.fn(async () => ({
    buffer: Buffer.from("iVBORw0KGgo=", "base64"),
    mimeType: "image/png",
    model: "test-image",
  }));
  const upload = vi.fn(async () => ({
    url: "/api/storage/messages/rel/asked.png",
    key: "messages/rel/asked.png",
    mimeType: "image/png",
    size: 12,
  }));
  let seen;
  await reply({
    body: { content: "can I see you", clientMessageId: "skip-photo-tool" },
    llm: {
      ...llm,
      async *streamChat(args) {
        seen = args;
        yield "here, from earlier.";
        yield {
          toolCalls: [{
            function: {
              name: "send_photo",
              arguments: JSON.stringify({ what: "stoop at dusk" }),
            },
          }],
        };
      },
    },
    mediaProvider: { generateImage },
    storage: { upload },
  });
  expect(seen.toolChoice).toBe("required");
  expect(seen.tools.map((tool) => tool.function.name)).toEqual([
    "text",
    "send_photo",
    "refuse_photo",
    "send_voice_note",
    "refuse_voice_note",
  ]);
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.content).toBe("here, from earlier.");
  expect(assistant.mediaType).toBe("image");
  expect(assistant.generation.mediaDecision).toBe("image_sent");
  expect(generateImage).toHaveBeenCalledOnce();
});
it("lets her classify a text turn with the text tool", async () => {
  let seen;
  await reply({
    llm: {
      ...llm,
      async *streamChat(args) {
        seen = args;
        yield "hey";
        yield { toolCalls: [{ function: { name: "text", arguments: "{}" } }] };
      },
    },
  });
  expect(seen.toolChoice).toBe("required");
  expect(seen.tools.map((tool) => tool.function.name)).toEqual([
    "text",
    "send_photo",
    "refuse_photo",
    "send_voice_note",
    "refuse_voice_note",
  ]);
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.content).toBe("hey");
  expect(assistant.mediaType).toBeUndefined();
  expect(assistant.generation.mediaDecision).toBe("text");
});
it("writes a chat bubble after a text tool call with no content", async () => {
  let calls = 0;
  await reply({
    llm: {
      ...llm,
      async *streamChat() {
        calls += 1;
        if (calls === 1) {
          yield { toolCalls: [{ id: "call_1", function: { name: "text", arguments: "{}" } }] };
          return;
        }
        yield "hey";
      },
    },
  });
  expect(calls).toBe(2);
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.status).toBe("completed");
  expect(assistant.content).toBe("hey");
  expect(assistant.mediaType).toBeUndefined();
  expect(assistant.generation.mediaDecision).toBe("text");
});
it("keeps the text reply if photo generation fails", async () => {
  await reply({
    llm: {
      ...llm,
      async *streamChat() {
        yield "sanding it down.";
        yield {
          toolCalls: [{
            function: {
              name: "send_photo",
              arguments: JSON.stringify({ what: "workshop table" }),
            },
          }],
        };
      },
    },
    mediaProvider: {
      generateImage: async () => {
        throw new Error("image model down");
      },
    },
    storage: { upload: vi.fn() },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.status).toBe("completed");
  expect(assistant.content).toBe("sanding it down.");
  expect(assistant.mediaType).toBeUndefined();
});
it("attaches a photo if the text claims she sent one but she forgot the tool", async () => {
  const generateImage = vi.fn(async () => ({
    buffer: Buffer.from("iVBORw0KGgo=", "base64"),
    mimeType: "image/png",
    model: "test-image",
  }));
  const upload = vi.fn(async () => ({
    url: "/api/storage/messages/rel/claimed.png",
    key: "messages/rel/claimed.png",
    mimeType: "image/png",
    size: 12,
  }));
  await reply({
    body: { content: "send a pic", clientMessageId: "request-claimed-photo" },
    llm: {
      ...llm,
      async *streamChat() {
        yield "fine. here's another. don't get used to it.";
      },
    },
    mediaProvider: { generateImage },
    storage: { upload },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.content).toBe("fine. here's another. don't get used to it.");
  expect(assistant.mediaType).toBe("image");
  expect(assistant.mediaUrl).toBe("/api/storage/messages/rel/claimed.png");
  expect(generateImage).toHaveBeenCalledOnce();
});
it("attaches synthesized audio from a send_voice_note tool call", async () => {
  const synthesize = vi.fn(async () => ({
    buffer: Buffer.from("ID3"),
    mimeType: "audio/mpeg",
    model: "test-tts",
  }));
  const upload = vi.fn(async () => ({
    url: "/api/storage/messages/rel/voice.mp3",
    key: "messages/rel/voice.mp3",
    mimeType: "audio/mpeg",
    size: 24,
  }));
  await reply({
    llm: {
      ...llm,
      async *streamChat() {
        yield "one sec";
        yield {
          toolCalls: [{
            function: {
              name: "send_voice_note",
              arguments: JSON.stringify({ spoken: "hey, wrapping the table now" }),
            },
          }],
        };
      },
    },
    mediaProvider: { synthesize },
    storage: { upload },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.content).toBe("one sec");
  expect(assistant.mediaType).toBe("audio");
  expect(assistant.mediaUrl).toBe("/api/storage/messages/rel/voice.mp3");
  expect(assistant.mediaMeta.transcript).toBe("hey, wrapping the table now");
  expect(assistant.mediaMeta.locked).toBe(true);
  expect(assistant.mediaMeta.unlockCost).toBe(50);
  expect(assistant.generation.mediaDecision).toBe("audio_sent");
  expect(synthesize).toHaveBeenCalledOnce();
  expect(synthesize.mock.calls[0][0].text).toBe("hey, wrapping the table now");
});
it("does not synthesize a voice note when the client has fewer than 50 hearts", async () => {
  const synthesize = vi.fn();
  const upload = vi.fn();
  await reply({
    body: { content: "I wanna hear you", clientMessageId: "broke-voice", clientGems: 49 },
    llm: {
      ...llm,
      async *streamChat() {
        yield "one sec";
        yield {
          toolCalls: [{
            function: {
              name: "send_voice_note",
              arguments: JSON.stringify({ spoken: "hey, wrapping the table now" }),
            },
          }],
        };
      },
    },
    mediaProvider: { synthesize },
    storage: { upload },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.mediaType).toBeUndefined();
  expect(assistant.mediaUrl).toBeUndefined();
  expect(assistant.generation.mediaDecision).toBe("audio_refused");
  expect(assistant.generation.mediaRefuseReason).toBe("insufficient_gems");
  expect(synthesize).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
});
it("does not attach audio when she called refuse_voice_note", async () => {
  const synthesize = vi.fn(async () => ({
    buffer: Buffer.from("ID3"),
    mimeType: "audio/mpeg",
    model: "test-tts",
  }));
  await reply({
    body: { content: "I wanna hear you", clientMessageId: "refuse-voice" },
    llm: {
      ...llm,
      async *streamChat() {
        yield "can't talk right now, texting.";
        yield {
          toolCalls: [{
            function: {
              name: "refuse_voice_note",
              arguments: JSON.stringify({ reason: "can't talk right now" }),
            },
          }],
        };
      },
    },
    mediaProvider: { synthesize },
    storage: { upload: vi.fn() },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.content).toBe("can't talk right now, texting.");
  expect(assistant.mediaType).toBeUndefined();
  expect(assistant.generation.mediaDecision).toBe("audio_refused");
  expect(synthesize).not.toHaveBeenCalled();
});
it("does not attach audio unless she called send_voice_note", async () => {
  const synthesize = vi.fn(async () => ({
    buffer: Buffer.from("ID3"),
    mimeType: "audio/mpeg",
    model: "test-tts",
  }));
  await reply({
    body: { content: "I wanna hear your voice", clientMessageId: "request-voice" },
    llm: {
      ...llm,
      async *streamChat() {
        yield "sure, wrapping up at the shop.";
      },
    },
    mediaProvider: { synthesize },
    storage: { upload: vi.fn() },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.content).toBe("sure, wrapping up at the shop.");
  expect(assistant.mediaType).toBeUndefined();
  expect(assistant.generation.mediaDecision).toBe("text");
  expect(synthesize).not.toHaveBeenCalled();
});
it("keeps the text reply if voice synthesis fails", async () => {
  await reply({
    llm: {
      ...llm,
      async *streamChat() {
        yield "one sec";
        yield {
          toolCalls: [{
            function: {
              name: "send_voice_note",
              arguments: JSON.stringify({ spoken: "wrapping up" }),
            },
          }],
        };
      },
    },
    mediaProvider: {
      synthesize: async () => {
        throw new Error("speech model down");
      },
    },
    storage: { upload: vi.fn() },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).lean();
  expect(assistant.status).toBe("completed");
  expect(assistant.content).toBe("one sec");
  expect(assistant.mediaType).toBeUndefined();
});

it("recovers stale streams without touching a current lease", async () => {
  await MessageModel.create({
    relationshipId: relationship._id,
    sequenceNumber: 1,
    role: "assistant",
    status: "streaming",
    content: "saved part",
  });
  await MessageModel.collection.updateMany(
    {},
    { $set: { updatedAt: new Date(0) } },
  );
  await RelationshipModel.updateOne(
    { _id: relationship._id },
    {
      $set: {
        chatLease: { token: "active", expiresAt: new Date(Date.now() + 60000) },
      },
    },
  );
  await recoverChatWork();
  expect((await MessageModel.findOne()).status).toBe("streaming");
  await RelationshipModel.updateOne(
    { _id: relationship._id },
    { $unset: { chatLease: 1 } },
  );
  await recoverChatWork();
  expect((await MessageModel.findOne()).status).toBe("partial");
});
it("rolls back a memory replacement if its archive cannot be written", async () => {
  const input = await source();
  const existing = await MemoryModel.create({
    relationshipId: relationship._id,
    userId: "alice",
    characterId: character._id,
    type: "user_fact",
    normalizedKey: "user_pet",
    text: "Has a dog",
    status: "active",
  });
  vi.spyOn(MemoryModel, "create").mockRejectedValueOnce(
    new Error("write failed"),
  );
  await expect(
    extractAndStoreMemory({
      ...input,
      llm: { generateJson: async () => extracted },
    }),
  ).rejects.toThrow("write failed");
  expect(await MemoryModel.findById(existing._id)).toMatchObject({
    status: "active",
    text: "Has a dog",
  });
  expect(
    (await RelationshipModel.findById(relationship._id)).summarySequence,
  ).toBe(0);
});
it("forgets deleted keys and does not rewind a summary on retry", async () => {
  const input = await source();
  await MemoryModel.create({
    relationshipId: relationship._id,
    userId: "alice",
    characterId: character._id,
    type: "user_fact",
    normalizedKey: "user_pet",
    text: "Has a dog",
    status: "deleted",
  });
  const generateJson = vi.fn(async () => extracted);
  await extractAndStoreMemory({ ...input, llm: { generateJson } });
  await extractAndStoreMemory({ ...input, llm: { generateJson } });
  expect(generateJson).toHaveBeenCalledTimes(1);
  expect(await MemoryModel.countDocuments({ status: "active" })).toBe(0);
  expect(
    (await RelationshipModel.findById(relationship._id)).relationshipSummary,
  ).toBe(extracted.relationshipSummary);
});
it("replaces a memory and archives the previous value atomically", async () => {
  const input = await source();
  await MemoryModel.create({
    relationshipId: relationship._id,
    userId: "alice",
    characterId: character._id,
    type: "user_fact",
    normalizedKey: "user_pet",
    text: "Has a dog",
    status: "active",
  });
  await extractAndStoreMemory({
    ...input,
    llm: { generateJson: async () => extracted },
  });
  expect((await MemoryModel.findOne({ status: "active" })).text).toBe(
    "Has a cat",
  );
  expect((await MemoryModel.findOne({ status: "superseded" })).text).toBe(
    "Has a dog",
  );
});
it("contains worker database failures without an unhandled rejection", async () => {
  vi.spyOn(MemoryJobModel, "findOneAndUpdate").mockRejectedValue(
    new Error("offline"),
  );
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const stop = startMemoryWorker({ llm, pollIntervalMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await stop();
  expect(log).toHaveBeenCalled();
});
it("isolates media edits by relationship and blocks production development auth", async () => {
  const storage = {
    delete: vi.fn(),
    upload: vi.fn(async () => ({
      url: "/uploads/new.png",
      key: `relationships/${relationship._id}/new.png`,
    })),
  };
  const server = createServer(createApp({ env, llm, storage }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const media = `/api/relationships/${relationship._id}/media`;
  try {
    const forbidden = await fetch(
      base + media + "/photos/" + character.gallery[0]._id,
      { method: "DELETE", headers: { "x-user-id": "bob" } },
    );
    expect(forbidden.status).toBe(404);
    const removed = await fetch(
      base + media + "/photos/" + character.gallery[0]._id,
      { method: "DELETE", headers: { "x-user-id": "alice" } },
    );
    expect(removed.status).toBe(204);
    expect((await CharacterModel.findById(character._id)).gallery).toHaveLength(
      1,
    );
    expect(
      (await RelationshipModel.findById(relationship._id)).media.gallery,
    ).toHaveLength(0);
    expect(storage.delete).not.toHaveBeenCalled();
    const form = new FormData();
    form.append(
      "photo",
      new Blob(["fake"], { type: "image/png" }),
      "photo.png",
    );
    const upload = await fetch(base + media + "/photos", {
      method: "POST",
      headers: { "x-user-id": "alice" },
      body: form,
    });
    expect(upload.status).toBe(201);
    expect((await upload.json()).data.gallery).toHaveLength(1);
    const sharedEdit = await fetch(
      base + `/api/characters/${character._id}/avatar`,
      { method: "PATCH", headers: { "x-user-id": "alice" } },
    );
    expect(sharedEdit.status).toBe(404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const production = createServer(
    createApp({ env: { ...env, NODE_ENV: "production" }, llm, storage }),
  );
  await new Promise((resolve) => production.listen(0, "127.0.0.1", resolve));
  try {
    expect(
      (
        await fetch(
          `http://127.0.0.1:${production.address().port}/api/characters`,
          { headers: { "x-user-id": "alice" } },
        )
      ).status,
    ).toBe(503);
  } finally {
    await new Promise((resolve) => production.close(resolve));
  }
});

it("extracts older facts without rewinding a newer summary and is idempotent", async () => {
  const older = await source();
  await reply({
    body: { content: "I like coffee", clientMessageId: "request-002" },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" }).sort({
    sequenceNumber: -1,
  });
  await extractAndStoreMemory({
    relationshipId: relationship._id,
    userMessageId: assistant.replyToMessageId,
    assistantMessageId: assistant._id,
    llm: {
      generateJson: async () => ({
        ...extracted,
        memories: [
          { ...extracted.memories[0], key: "user_drink", text: "Likes coffee" },
        ],
        relationshipSummary: "Coffee discussion",
      }),
    },
  });
  const generateJson = vi.fn(async () => extracted);
  await extractAndStoreMemory({ ...older, llm: { generateJson } });
  await extractAndStoreMemory({ ...older, llm: { generateJson } });
  expect(generateJson).toHaveBeenCalledTimes(1);
  expect(await MemoryModel.countDocuments({ status: "active" })).toBe(2);
  expect(
    (await RelationshipModel.findById(relationship._id)).relationshipSummary,
  ).toBe("Coffee discussion");
});

it("forgets the whole key, clears old model context, and blocks delayed extraction", async () => {
  const { forgetMemory } =
    await import("../src/services/forget-memory.service.js");
  const { assembleContext } =
    await import("../src/services/context.service.js");
  const input = await source();
  await extractAndStoreMemory({
    ...input,
    llm: { generateJson: async () => extracted },
  });
  const memory = await MemoryModel.findOne({ status: "active" });
  await MemoryModel.create({
    ...memory.toObject(),
    _id: undefined,
    status: "superseded",
  });
  await forgetMemory({
    relationshipId: relationship._id,
    userId: "alice",
    memoryId: memory._id,
  });
  const context = await assembleContext({
    relationshipId: relationship._id,
    userId: "alice",
    currentMessage: "What do you remember?",
  });
  expect(context.messages).toHaveLength(2);
  expect(context.messages[0].content).not.toContain("They discussed pets");
  expect(context.retrievedMemoryIds).toEqual([]);
  expect(await MemoryModel.countDocuments({ status: { $ne: "deleted" } })).toBe(
    0,
  );
  const generateJson = vi.fn();
  await extractAndStoreMemory({ ...input, llm: { generateJson } });
  expect(generateJson).not.toHaveBeenCalled();
  expect(await MessageModel.countDocuments()).toBe(2);
});

it("persists supported templates, names and evidence-backed relationship changes", async () => {
  character.promptTemplate = "Quiet and thoughtful voice";
  await character.save();
  expect((await CharacterModel.findById(character._id)).promptTemplate).toBe(
    "Quiet and thoughtful voice",
  );
  await reply({
    body: {
      content: "Call me Ayush. Let's be friends.",
      clientMessageId: "request-name",
    },
  });
  const assistant = await MessageModel.findOne({ role: "assistant" });
  await extractAndStoreMemory({
    relationshipId: relationship._id,
    userMessageId: assistant.replyToMessageId,
    assistantMessageId: assistant._id,
    llm: {
      generateJson: async () => ({
        ...extracted,
        relationshipUpdate: {
          nameStatus: "known",
          preferredName: "Ayush",
          stage: "friends",
          evidence: "Call me Ayush. Let's be friends.",
        },
      }),
    },
  });
  const saved = await RelationshipModel.findById(relationship._id);
  expect(saved.stage).toBe("friends");
  expect(saved.introduction.preferredName).toBe("Ayush");
});

it("rejects fabricated evidence for name or romance", async () => {
  const input = await source();
  await extractAndStoreMemory({
    ...input,
    llm: {
      generateJson: async () => ({
        ...extracted,
        relationshipUpdate: {
          stage: "romantic",
          nameStatus: "known",
          preferredName: "Ayush",
          evidence: "I'm Ayush and want to be partners",
        },
      }),
    },
  });
  const saved = await RelationshipModel.findById(relationship._id);
  expect(saved.stage).toBe("new");
  expect(saved.introduction?.preferredName).toBeUndefined();
});

it("keeps a newer name correction when an old introduction completes late", async () => {
  await reply({
    body: { content: "Call me Ayush", clientMessageId: "name-original" },
  });
  const old = await MessageModel.findOne({ role: "assistant" });
  await reply({
    body: { content: "Call me Ash", clientMessageId: "name-corrected" },
  });
  const latest = await MessageModel.findOne({ role: "assistant" }).sort({
    sequenceNumber: -1,
  });
  const extractName = (message, name) =>
    extractAndStoreMemory({
      relationshipId: relationship._id,
      userMessageId: message.replyToMessageId,
      assistantMessageId: message._id,
      llm: {
        generateJson: async () => ({
          ...extracted,
          memories: [
            {
              ...extracted.memories[0],
              key: "user_name",
              text: `User name is ${name}`,
            },
          ],
          relationshipUpdate: {
            nameStatus: "known",
            preferredName: name,
            evidence: `Call me ${name}`,
          },
        }),
      },
    });
  await extractName(latest, "Ash");
  await extractName(old, "Ayush");
  expect(
    (await RelationshipModel.findById(relationship._id)).introduction
      .preferredName,
  ).toBe("Ash");
  expect(
    (
      await MemoryModel.findOne({
        normalizedKey: "user_name",
        status: "active",
      })
    ).text,
  ).toBe("User name is Ash");
});

it("does not restore a forgotten fact when an in-flight extraction returns", async () => {
  const { forgetMemory } =
    await import("../src/services/forget-memory.service.js");
  const input = await source();
  const memory = await MemoryModel.create({
    relationshipId: relationship._id,
    userId: "alice",
    characterId: character._id,
    type: "user_fact",
    normalizedKey: "user_pet",
    text: "Has a cat",
  });
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const work = extractAndStoreMemory({
    ...input,
    llm: {
      generateJson: async () => {
        started();
        await gate;
        return extracted;
      },
    },
  });
  await waiting;
  await forgetMemory({
    relationshipId: relationship._id,
    userId: "alice",
    memoryId: memory._id,
  });
  release();
  await work;
  expect(await MemoryModel.countDocuments({ status: "active" })).toBe(0);
  expect(
    (await RelationshipModel.findById(relationship._id)).relationshipSummary,
  ).toBe("");
});

it("retrieves relevant facts beyond the first six without injecting them into unrelated turns", async () => {
  const { retrieveMemories } =
    await import("../src/services/memory.service.js");
  await MemoryModel.create(
    Array.from({ length: 8 }, (_, i) => ({
      relationshipId: relationship._id,
      userId: "alice",
      characterId: character._id,
      type: "user_fact",
      normalizedKey: `fact_${i}`,
      text: `Fact ${i}`,
      importance: 0.9,
    })),
  );
  expect(
    await retrieveMemories({
      relationshipId: relationship._id,
      userId: "alice",
      query: "ok",
      vectorEnabled: false,
    }),
  ).toEqual([]);
  const memories = await retrieveMemories({
    relationshipId: relationship._id,
    userId: "alice",
    query: "what fact did I tell you?",
    vectorEnabled: false,
  });
  expect(memories).toHaveLength(8);
});

it("keeps a grounded habit available on greetings, replaces corrections, and forgets it everywhere", async () => {
  const { assembleContext } = await import("../src/services/context.service.js");
  const { forgetMemory } = await import("../src/services/forget-memory.service.js");
  async function extractHabit(content, text, id) {
    await reply({body: {content, clientMessageId: id}});
    const assistant = await MessageModel.findOne({role: "assistant"}).sort({sequenceNumber: -1});
    await extractAndStoreMemory({relationshipId: relationship._id, userMessageId: assistant.replyToMessageId, assistantMessageId: assistant._id,
      llm: {generateJson: async () => ({mood: "neutral", memories: [{type: "user_fact", key: "user_gaming", text, confidence: 0.95, importance: 0.9, dossierCategory: "habit", evidence: content}]})}});
  }
  await extractHabit("I play Valorant until 3am", "Plays Valorant until 3am", "habit-one");
  let context = await assembleContext({relationshipId: relationship._id, userId: "alice", currentMessage: "hey"});
  expect(context.messages[0].content).toContain("Personal dossier");
  expect(context.messages[0].content).toContain("Plays Valorant until 3am");
  await extractHabit("I quit Valorant", "Quit Valorant", "habit-two");
  context = await assembleContext({relationshipId: relationship._id, userId: "alice", currentMessage: "hey"});
  expect(context.messages[0].content).toContain("Quit Valorant");
  expect(context.messages[0].content).not.toContain("Plays Valorant until 3am");
  const memory = await MemoryModel.findOne({status: "active", normalizedKey: "user_gaming"});
  await forgetMemory({relationshipId: relationship._id, userId: "alice", memoryId: memory._id});
  context = await assembleContext({relationshipId: relationship._id, userId: "alice", currentMessage: "hey"});
  expect(JSON.stringify(context.messages)).not.toContain("Valorant");
});

it("includes 50 dated messages in chronological order while respecting the recent token budget", async () => {
  const { assembleContext } = await import("../src/services/context.service.js");
  const { estimateTokens } = await import("../src/utils/tokens.js");
  await MessageModel.insertMany(Array.from({length: 60}, (_, i) => ({relationshipId: relationship._id, sequenceNumber: i + 1, role: i % 2 ? "assistant" : "user", content: `turn number ${i + 1}`, status: "completed", createdAt: new Date("2026-09-23T09:00:00Z")})));
  const input = {relationshipId: relationship._id, userId: "alice", currentMessage: "hi", userTimezone: "Asia/Kolkata"};
  const context = await assembleContext(input);
  const history = context.messages.slice(1, -1);
  expect(history).toHaveLength(50);
  expect(history[0].content).toContain("turn number 11");
  expect(history.at(-1).content).toContain("turn number 60");
  expect(history[0].content).toContain("14:30 (Asia/Kolkata)");
  const small = await assembleContext({...input, recentTokenBudget: 100});
  expect(small.messages.slice(1, -1).reduce((n, m) => n + estimateTokens(m.content) + 4, 0)).toBeLessThanOrEqual(100);
});

it("recalls an old low-priority fact beyond 50 unrelated memories without changing fact dates", async () => {
  const { retrieveMemories } = await import("../src/services/memory.service.js");
  const base = {relationshipId: relationship._id, userId: "alice", characterId: character._id, type: "user_fact"};
  await MemoryModel.insertMany(Array.from({length: 70}, (_, i) => ({...base, normalizedKey: `unrelated_${i}`, text: `Unrelated memory ${i}`, importance: 1})));
  const cafe = await MemoryModel.create({...base, normalizedKey: "tokyo_cafe", text: "Loved Kissa Aoyama in Tokyo", importance: 0.1});
  const memories = await retrieveMemories({relationshipId: String(relationship._id), userId: "alice", query: "that Tokyo cafe", vectorEnabled: false});
  expect(memories.map(m => m.text)).toContain(cafe.text);
  const after = await MemoryModel.findById(cafe._id);
  expect(after.updatedAt).toEqual(cafe.updatedAt);
  expect(after.lastRetrievedAt).toBeInstanceOf(Date);
  expect(await retrieveMemories({relationshipId: relationship._id, userId: "bob", query: "Tokyo"})).toEqual([]);
});

it("revalidates vector hits so stale deleted text cannot return and casts relationship filters", async () => {
  const { retrieveMemories } = await import("../src/services/memory.service.js");
  const forgotten = await MemoryModel.create({relationshipId: relationship._id, userId: "alice", characterId: character._id, type: "user_fact", normalizedKey: "old_secret", text: "Forgotten detail", status: "deleted"});
  const aggregate = vi.spyOn(MemoryModel, "aggregate").mockResolvedValue([{...forgotten.toObject(), score: 0.95}]);
  const provider = {model: "embedding-test", embed: vi.fn(async () => [0.1, 0.2])};
  expect(await retrieveMemories({relationshipId: String(relationship._id), userId: "alice", query: "remind me", vectorEnabled: true, embeddingProvider: provider, vectorIndexName: "memory_vector_index"})).toEqual([]);
  const filter = aggregate.mock.calls[0][0][0].$vectorSearch.filter;
  expect(filter.relationshipId.$eq).toBeInstanceOf(mongoose.Types.ObjectId);
  expect(filter.userId.$eq).toBe("alice");
  expect(filter.embeddingModel.$eq).toBe("embedding-test");
});

it("does not restore an embedding if a memory is deleted while backfill is awaiting the provider", async () => {
  const { backfillEmbeddings } = await import("../src/services/memory-maintenance.service.js");
  const memory = await MemoryModel.create({relationshipId: relationship._id, userId: "alice", characterId: character._id, type: "user_fact", normalizedKey: "user_pet", text: "Has a cat"});
  const provider = {model: "embedding-test", dimensions: 2, embed: async () => {
    await MemoryModel.updateOne({_id: memory._id}, {$set: {status: "deleted"}});
    return [0.1, 0.2];
  }};
  expect(await backfillEmbeddings(provider)).toBe(0);
  expect((await MemoryModel.findById(memory._id).select("+embedding")).embedding).toBeUndefined();
});

it("fills a missing vector even when extraction repeats the same text", async () => {
  const input = await source();
  await MemoryModel.create({relationshipId: relationship._id, userId: "alice", characterId: character._id, type: "user_fact", normalizedKey: "user_pet", text: "Has a cat"});
  await extractAndStoreMemory({...input, llm: {generateJson: async () => extracted}, embeddingProvider: {model: "embedding-test", embed: async () => [0.1, 0.2]}});
  const memory = await MemoryModel.findOne({normalizedKey: "user_pet", status: "active"}).select("+embedding +embeddingModel");
  expect(memory.embedding).toEqual([0.1, 0.2]);
  expect(memory.embeddingModel).toBe("embedding-test");
});

it("finds original evidence when legacy memories reference a later acknowledgement, and resumes safely", async () => {
  const { backfillDossiers } = await import("../src/services/memory-maintenance.service.js");
  const user = await MessageModel.create({relationshipId: relationship._id, sequenceNumber: 1, role: "user", content: "I drink black coffee", status: "completed"});
  const acknowledgement = await MessageModel.create({relationshipId: relationship._id, sequenceNumber: 2, role: "user", content: "nice", status: "completed"});
  const base = {relationshipId: relationship._id, userId: "alice", characterId: character._id, type: "preference", sourceMessageIds: [acknowledgement._id], sourceSequence: 3, confidence: 0.9};
  await MemoryModel.create([{...base, normalizedKey: "user_coffee", text: "Drinks black coffee"}, {...base, normalizedKey: "user_tea", text: "Loves tea"}]);
  const generateJson = vi.fn(async () => ({mood: "neutral", memories: [
    {type: "preference", key: "user_coffee", text: "Drinks black coffee", confidence: 0.9, importance: 0.8, dossierCategory: "preference", evidence: "I drink black coffee"},
    {type: "preference", key: "user_tea", text: "Loves tea", confidence: 0.9, importance: 0.8, dossierCategory: "preference", evidence: "I love tea"},
  ]}));
  expect(await backfillDossiers({generateJson})).toBe(2);
  const rel = await RelationshipModel.findById(relationship._id);
  expect(rel.userDossier.entries.map(e => e.text)).toEqual(["Drinks black coffee"]);
  expect((await MemoryModel.findOne({normalizedKey: "user_coffee"})).sourceMessageIds.map(String)).toContain(String(user._id));
  expect(await backfillDossiers({generateJson})).toBe(0);
  expect(generateJson).toHaveBeenCalledTimes(1);
});

it("keeps newer dossier facts when a delayed extraction finishes and tracks actual callbacks", async () => {
  const { refreshDossier } = await import("../src/services/dossier.service.js");
  const input = await source();
  const memory = await MemoryModel.create({relationshipId: relationship._id, userId: "alice", characterId: character._id, type: "user_fact", normalizedKey: "user_pet", text: "Has a cat", dossierCategory: "fact", confidence: 0.95, sourceSequence: 20});
  await refreshDossier(relationship);
  await relationship.save();
  await extractAndStoreMemory({...input, llm: {generateJson: async () => ({...extracted, memories: [{...extracted.memories[0], text: "Has a dog", dossierCategory: "fact", evidence: "hello"}], callbacks: [{key: "user_pet", evidence: "hello"}]})}});
  const rel = await RelationshipModel.findById(relationship._id);
  expect(rel.userDossier.entries[0].text).toBe("Has a cat");
  expect((await MemoryModel.findById(memory._id)).lastMentionedAt).toBeInstanceOf(Date);
});
