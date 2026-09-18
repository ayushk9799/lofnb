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
