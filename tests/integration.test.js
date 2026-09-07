import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
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
import { recoverChatWork, startMemoryWorker } from "../src/workers/memory.worker.js";
const models = [CharacterModel, RelationshipModel, MessageModel, MemoryModel, MemoryJobModel];
const env = {NODE_ENV:"test", ALLOW_DEV_AUTH:true, CORS_ORIGIN:"http://localhost:5173", MEMORY_VECTOR_SEARCH_ENABLED:false};
let database, character, relationship;
beforeAll(async () => {
    database = await MongoMemoryReplSet.create({replSet:{count:1}});
    await mongoose.connect(database.getUri());
    await Promise.all(models.map(model => model.init()));
});
afterAll(async () => {await mongoose.disconnect(); await database?.stop();});
beforeEach(async () => {
    await Promise.all(models.map(model => model.deleteMany({})));
    character = await CharacterModel.create({slug:"robin", name:"Robin", age:44, persona:{summary:"Architect"}, backstory:{summary:"Lives in London"}, gallery:[{url:"https://example.com/photo.png",caption:"Original"}]});
    relationship = await RelationshipModel.create({userId:"alice",characterId:character._id});
});
afterEach(() => vi.restoreAllMocks());
const llm = {name:"fake", model:"fake", async *streamChat() {yield "hello";}, async generateText() {return "hey there";}};
function reply(overrides = {}) {
    return generateReply({relationshipId:relationship._id, userId:"alice", body:{content:"hello",clientMessageId:"request-001"}, env, llm, signal:new AbortController().signal, emit:()=>{}, ...overrides});
}
async function source() {
    await reply();
    const user = await MessageModel.findOne({role:"user"});
    const assistant = await MessageModel.findOne({role:"assistant"});
    return {relationshipId:relationship._id, userMessageId:user._id, assistantMessageId:assistant._id};
}
const extracted = {memories:[{type:"user_fact",key:"user_pet",text:"Has a cat",confidence:0.9,importance:0.8}], relationshipSummary:"They discussed pets", mood:"happy"};

it("serializes concurrent turns, replays retries, and rejects changed content", async () => {
    let release, started;
    const waiting = new Promise(resolve => {started = resolve;});
    const gate = new Promise(resolve => {release = resolve;});
    const first = reply({llm:{...llm, async *streamChat() {started(); await gate; yield "hello";}}});
    await waiting;
    await expect(reply()).rejects.toMatchObject({code:"CHAT_BUSY"});
    release(); await first;
    const events = []; await reply({emit:(event, data) => events.push([event,data])});
    expect(events.at(-1)[1].cached).toBe(true);
    expect(await MessageModel.countDocuments()).toBe(2);
    expect(await MemoryJobModel.countDocuments()).toBe(1);
    await expect(reply({body:{content:"different",clientMessageId:"request-001"}})).rejects.toMatchObject({code:"MESSAGE_CONFLICT"});
});
it("retains completed replies if job scheduling fails, then recovers the outbox", async () => {
    const mock = vi.spyOn(MemoryJobModel,"updateOne").mockRejectedValueOnce(new Error("database unavailable"));
    await reply();
    expect(await MessageModel.findOne({role:"assistant"})).toMatchObject({status:"completed",memoryPending:true});
    mock.mockRestore(); await recoverChatWork();
    expect(await MemoryJobModel.countDocuments()).toBe(1);
    expect(await MessageModel.findOne({role:"assistant"})).toMatchObject({memoryPending:false,status:"completed"});
});
it("keeps partial text and does not extract memories from an interrupted reply", async () => {
    await expect(reply({llm:{...llm, async *streamChat() {yield "part"; throw new Error("disconnected");}}})).rejects.toThrow();
    expect(await MessageModel.findOne({role:"assistant"})).toMatchObject({content:"part",status:"partial"});
    expect(await MemoryJobModel.countDocuments()).toBe(0);
});
it("retries a failed empty reply without duplicating the user message", async () => {
    await expect(reply({llm:{...llm, async *streamChat() { yield ""; throw new Error("unavailable"); }}})).rejects.toThrow();
    await reply(); expect(await MessageModel.countDocuments()).toBe(2);
    expect(await MessageModel.findOne({role:"assistant"})).toMatchObject({status:"completed"});
});
it("recovers stale streams without touching a current lease", async () => {
    await MessageModel.create({relationshipId:relationship._id,sequenceNumber:1,role:"assistant",status:"streaming",content:"saved part"});
    await MessageModel.collection.updateMany({},{$set:{updatedAt:new Date(0)}});
    await RelationshipModel.updateOne({_id:relationship._id},{$set:{chatLease:{token:"active",expiresAt:new Date(Date.now()+60000)}}});
    await recoverChatWork(); expect((await MessageModel.findOne()).status).toBe("streaming");
    await RelationshipModel.updateOne({_id:relationship._id},{$unset:{chatLease:1}});
    await recoverChatWork(); expect((await MessageModel.findOne()).status).toBe("partial");
});
it("rolls back a memory replacement if its archive cannot be written", async () => {
    const input = await source();
    const existing = await MemoryModel.create({relationshipId:relationship._id,userId:"alice",characterId:character._id,type:"user_fact",normalizedKey:"user_pet",text:"Has a dog",status:"active"});
    vi.spyOn(MemoryModel,"create").mockRejectedValueOnce(new Error("write failed"));
    await expect(extractAndStoreMemory({...input,llm:{generateJson:async()=>extracted}})).rejects.toThrow("write failed");
    expect(await MemoryModel.findById(existing._id)).toMatchObject({status:"active",text:"Has a dog"});
    expect((await RelationshipModel.findById(relationship._id)).summarySequence).toBe(0);
});
it("forgets deleted keys and does not rewind a summary on retry", async () => {
    const input = await source();
    await MemoryModel.create({relationshipId:relationship._id,userId:"alice",characterId:character._id,type:"user_fact",normalizedKey:"user_pet",text:"Has a dog",status:"deleted"});
    const generateJson = vi.fn(async()=>extracted);
    await extractAndStoreMemory({...input,llm:{generateJson}});
    await extractAndStoreMemory({...input,llm:{generateJson}});
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(await MemoryModel.countDocuments({status:"active"})).toBe(0);
    expect((await RelationshipModel.findById(relationship._id)).relationshipSummary).toBe(extracted.relationshipSummary);
});
it("replaces a memory and archives the previous value atomically", async () => {
    const input = await source();
    await MemoryModel.create({relationshipId:relationship._id,userId:"alice",characterId:character._id,type:"user_fact",normalizedKey:"user_pet",text:"Has a dog",status:"active"});
    await extractAndStoreMemory({...input,llm:{generateJson:async()=>extracted}});
    expect((await MemoryModel.findOne({status:"active"})).text).toBe("Has a cat");
    expect((await MemoryModel.findOne({status:"superseded"})).text).toBe("Has a dog");
});
it("contains worker database failures without an unhandled rejection", async () => {
    vi.spyOn(MemoryJobModel,"findOneAndUpdate").mockRejectedValue(new Error("offline"));
    const log = vi.spyOn(console,"error").mockImplementation(()=>{});
    const stop = startMemoryWorker({llm,pollIntervalMs:10});
    await new Promise(resolve=>setTimeout(resolve,80)); await stop();
    expect(log).toHaveBeenCalled();
});
it("isolates media edits by relationship and blocks production development auth", async () => {
    const storage = {delete:vi.fn(),upload:vi.fn(async()=>({url:"/uploads/new.png",key:`relationships/${relationship._id}/new.png`}))};
    const server = createServer(createApp({env,llm,storage}));
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const media = `/api/relationships/${relationship._id}/media`;
    try {
        const forbidden = await fetch(base+media+"/photos/"+character.gallery[0]._id,{method:"DELETE",headers:{"x-user-id":"bob"}});
        expect(forbidden.status).toBe(404);
        const removed = await fetch(base+media+"/photos/"+character.gallery[0]._id,{method:"DELETE",headers:{"x-user-id":"alice"}});
        expect(removed.status).toBe(204);
        expect((await CharacterModel.findById(character._id)).gallery).toHaveLength(1);
        expect((await RelationshipModel.findById(relationship._id)).media.gallery).toHaveLength(0);
        expect(storage.delete).not.toHaveBeenCalled();
        const form = new FormData(); form.append("photo",new Blob(["fake"],{type:"image/png"}),"photo.png");
        const upload = await fetch(base+media+"/photos",{method:"POST",headers:{"x-user-id":"alice"},body:form});
        expect(upload.status).toBe(201);
        expect((await upload.json()).data.gallery).toHaveLength(1);
        const sharedEdit = await fetch(base+`/api/characters/${character._id}/avatar`,{method:"PATCH",headers:{"x-user-id":"alice"}});
        expect(sharedEdit.status).toBe(404);
    } finally {await new Promise(resolve=>server.close(resolve));}
    const production = createServer(createApp({env:{...env,NODE_ENV:"production"},llm,storage}));
    await new Promise(resolve=>production.listen(0,"127.0.0.1",resolve));
    try { expect((await fetch(`http://127.0.0.1:${production.address().port}/api/characters`,{headers:{"x-user-id":"alice"}})).status).toBe(503); }
    finally {await new Promise(resolve=>production.close(resolve));}
});

it("extracts older facts without rewinding a newer summary and is idempotent", async () => {
    const older = await source();
    await reply({body:{content:"I like coffee",clientMessageId:"request-002"}});
    const assistant = await MessageModel.findOne({role:"assistant"}).sort({sequenceNumber:-1});
    await extractAndStoreMemory({relationshipId:relationship._id,userMessageId:assistant.replyToMessageId,assistantMessageId:assistant._id,
        llm:{generateJson:async()=>({...extracted,memories:[{...extracted.memories[0],key:"user_drink",text:"Likes coffee"}],relationshipSummary:"Coffee discussion"})}});
    const generateJson = vi.fn(async()=>extracted);
    await extractAndStoreMemory({...older,llm:{generateJson}});
    await extractAndStoreMemory({...older,llm:{generateJson}});
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(await MemoryModel.countDocuments({status:"active"})).toBe(2);
    expect((await RelationshipModel.findById(relationship._id)).relationshipSummary).toBe("Coffee discussion");
});

it("forgets the whole key, clears old model context, and blocks delayed extraction", async () => {
    const {forgetMemory} = await import("../src/services/forget-memory.service.js");
    const {assembleContext} = await import("../src/services/context.service.js");
    const input = await source();
    await extractAndStoreMemory({...input,llm:{generateJson:async()=>extracted}});
    const memory = await MemoryModel.findOne({status:"active"});
    await MemoryModel.create({...memory.toObject(),_id:undefined,status:"superseded"});
    await forgetMemory({relationshipId:relationship._id,userId:"alice",memoryId:memory._id});
    const context = await assembleContext({relationshipId:relationship._id,userId:"alice",currentMessage:"What do you remember?"});
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0].content).not.toContain("They discussed pets");
    expect(context.retrievedMemoryIds).toEqual([]);
    expect(await MemoryModel.countDocuments({status:{$ne:"deleted"}})).toBe(0);
    const generateJson = vi.fn();
    await extractAndStoreMemory({...input,llm:{generateJson}});
    expect(generateJson).not.toHaveBeenCalled();
    expect(await MessageModel.countDocuments()).toBe(2);
});

it("persists supported templates, names and evidence-backed relationship changes", async () => {
    character.promptTemplate = "Quiet and thoughtful voice";
    await character.save();
    expect((await CharacterModel.findById(character._id)).promptTemplate).toBe("Quiet and thoughtful voice");
    await reply({body:{content:"Call me Ayush. Let's be friends.",clientMessageId:"request-name"}});
    const assistant = await MessageModel.findOne({role:"assistant"});
    await extractAndStoreMemory({relationshipId:relationship._id,userMessageId:assistant.replyToMessageId,assistantMessageId:assistant._id,
        llm:{generateJson:async()=>({...extracted,relationshipUpdate:{nameStatus:"known",preferredName:"Ayush",stage:"friends",evidence:"Call me Ayush. Let's be friends."}})}});
    const saved = await RelationshipModel.findById(relationship._id);
    expect(saved.stage).toBe("friends");
    expect(saved.introduction.preferredName).toBe("Ayush");
});

it("rejects fabricated evidence for name or romance", async () => {
    const input = await source();
    await extractAndStoreMemory({...input,llm:{generateJson:async()=>({...extracted,relationshipUpdate:{stage:"romantic",nameStatus:"known",preferredName:"Ayush",evidence:"I'm Ayush and want to be partners"}})}});
    const saved = await RelationshipModel.findById(relationship._id);
    expect(saved.stage).toBe("new");
    expect(saved.introduction?.preferredName).toBeUndefined();
});

it("keeps a newer name correction when an old introduction completes late", async () => {
    await reply({body:{content:"Call me Ayush",clientMessageId:"name-original"}});
    const old = await MessageModel.findOne({role:"assistant"});
    await reply({body:{content:"Call me Ash",clientMessageId:"name-corrected"}});
    const latest = await MessageModel.findOne({role:"assistant"}).sort({sequenceNumber:-1});
    const extractName = (message, name) => extractAndStoreMemory({relationshipId:relationship._id,userMessageId:message.replyToMessageId,assistantMessageId:message._id,
        llm:{generateJson:async()=>({...extracted,memories:[{...extracted.memories[0],key:"user_name",text:`User name is ${name}`}],relationshipUpdate:{nameStatus:"known",preferredName:name,evidence:`Call me ${name}`}})}});
    await extractName(latest,"Ash");
    await extractName(old,"Ayush");
    expect((await RelationshipModel.findById(relationship._id)).introduction.preferredName).toBe("Ash");
    expect((await MemoryModel.findOne({normalizedKey:"user_name",status:"active"})).text).toBe("User name is Ash");
});

it("does not restore a forgotten fact when an in-flight extraction returns", async () => {
    const {forgetMemory} = await import("../src/services/forget-memory.service.js");
    const input = await source();
    const memory = await MemoryModel.create({relationshipId:relationship._id,userId:"alice",characterId:character._id,type:"user_fact",normalizedKey:"user_pet",text:"Has a cat"});
    let release, started;
    const gate = new Promise(resolve => {release = resolve;});
    const waiting = new Promise(resolve => {started = resolve;});
    const work = extractAndStoreMemory({...input,llm:{generateJson:async()=>{started();await gate;return extracted;}}});
    await waiting;
    await forgetMemory({relationshipId:relationship._id,userId:"alice",memoryId:memory._id});
    release(); await work;
    expect(await MemoryModel.countDocuments({status:"active"})).toBe(0);
    expect((await RelationshipModel.findById(relationship._id)).relationshipSummary).toBe("");
});

it("retrieves important facts beyond the first six when vector search is off", async () => {
    const {retrieveMemories} = await import("../src/services/memory.service.js");
    await MemoryModel.create(Array.from({length:8},(_,i)=>({relationshipId:relationship._id,userId:"alice",characterId:character._id,type:"user_fact",normalizedKey:`fact_${i}`,text:`Fact ${i}`,importance:0.9})));
    const memories = await retrieveMemories({relationshipId:relationship._id,userId:"alice",query:"",vectorEnabled:false});
    expect(memories).toHaveLength(8);
});
