function endpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}/${path}`;
}

function wrapPcm16InWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

function headers(baseUrl, apiKey, json = true) {
  const value = { Authorization: `Bearer ${apiKey}` };
  if (json) value["Content-Type"] = "application/json";
  if (baseUrl.includes("openrouter.ai")) {
    value["HTTP-Referer"] = "https://lofn.ai";
    value["X-Title"] = "Lofn Companion";
  }
  return value;
}

async function assertOk(response) {
  if (response.ok) return;
  const body = await response.text();
  throw new Error(`Media model returned ${response.status}: ${body.slice(0, 500)}`);
}

function extensionForMime(mimeType = "") {
  if (/mpeg|mp3/.test(mimeType)) return "mp3";
  if (/mp4|m4a/.test(mimeType)) return "m4a";
  if (/ogg/.test(mimeType)) return "ogg";
  if (/flac/.test(mimeType)) return "flac";
  if (/aac/.test(mimeType)) return "aac";
  if (/webm/.test(mimeType)) return "webm";
  return "wav";
}

const SILENCE_TOKEN = "[silence]";
const TRANSCRIBE_PROMPT =
  "Transcribe the speech in this audio verbatim, in the language spoken. " +
  "Output only the transcript with no commentary or quotes. " +
  `If there is no intelligible speech, output exactly ${SILENCE_TOKEN}.`;

export class TranscriptionError extends Error {
  constructor(message, { cause, attempts } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "TranscriptionError";
    this.attempts = attempts || [];
  }
}

export class OpenRouterMediaProvider {
  constructor({ baseUrl, apiKey, transcriptionModel, audioModel, speechModel, imageModel, voice }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.transcriptionModel = transcriptionModel;
    // Chat model that accepts `input_audio` parts. Used when the dedicated
    // transcription endpoint fails or hears nothing, so a voice note is never
    // dropped just because one model could not decode it.
    this.audioModel = audioModel;
    this.speechModel = speechModel;
    this.imageModel = imageModel;
    this.voice = voice || "alloy";
  }

  /**
   * Returns `{ text, model, usage, empty }`. `empty: true` means every model
   * decoded the file but heard no speech. Throws TranscriptionError only when
   * no model could process the audio at all.
   */
  async transcribe({ buffer, mimeType, signal }) {
    if (!this.transcriptionModel && !this.audioModel) {
      throw new TranscriptionError("Transcription model is not configured");
    }
    const attempts = [];
    if (this.transcriptionModel) {
      try {
        const result = await this.#transcribeViaEndpoint({ buffer, mimeType, signal });
        if (result.text) return result;
        attempts.push({ model: this.transcriptionModel, outcome: "empty" });
      } catch (error) {
        if (signal?.aborted) throw error;
        attempts.push({ model: this.transcriptionModel, outcome: "error", message: error.message });
      }
    }
    if (this.audioModel) {
      try {
        const result = await this.#transcribeViaChat({ buffer, mimeType, signal });
        if (result.text) return result;
        attempts.push({ model: this.audioModel, outcome: "empty" });
      } catch (error) {
        if (signal?.aborted) throw error;
        attempts.push({ model: this.audioModel, outcome: "error", message: error.message });
      }
    }
    if (attempts.some(attempt => attempt.outcome === "empty")) {
      return { text: "", model: attempts.find(a => a.outcome === "empty").model, empty: true, attempts };
    }
    throw new TranscriptionError(
      `No model could transcribe the voice note: ${attempts.map(a => `${a.model} → ${a.message}`).join("; ")}`,
      { attempts },
    );
  }

  async #transcribeViaEndpoint({ buffer, mimeType, signal }) {
    const form = new FormData();
    form.append("model", this.transcriptionModel);
    form.append("file", new Blob([buffer], { type: mimeType }), `voice.${extensionForMime(mimeType)}`);
    const response = await fetch(endpoint(this.baseUrl, "audio/transcriptions"), {
      method: "POST",
      headers: headers(this.baseUrl, this.apiKey, false),
      body: form,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    await assertOk(response);
    const payload = await response.json();
    return { text: String(payload.text || "").trim(), model: this.transcriptionModel, usage: payload.usage };
  }

  async #transcribeViaChat({ buffer, mimeType, signal }) {
    const response = await fetch(endpoint(this.baseUrl, "chat/completions"), {
      method: "POST",
      headers: headers(this.baseUrl, this.apiKey),
      body: JSON.stringify({
        model: this.audioModel,
        temperature: 0,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: TRANSCRIBE_PROMPT },
            { type: "input_audio", input_audio: { data: buffer.toString("base64"), format: extensionForMime(mimeType) } },
          ],
        }],
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    await assertOk(response);
    const payload = await response.json();
    const raw = payload.choices?.[0]?.message?.content;
    const content = Array.isArray(raw)
      ? raw.map(part => (typeof part === "string" ? part : part?.text || "")).join("")
      : String(raw || "");
    const text = content.trim();
    const heardNothing = !text || text.toLowerCase() === SILENCE_TOKEN || /^\[?(silence|no speech|inaudible)\]?\.?$/i.test(text);
    return { text: heardNothing ? "" : text, model: this.audioModel, usage: payload.usage };
  }

  async generateImage({ prompt, signal }) {
    if (!this.imageModel) throw new Error("Image generation model is not configured");
    const path = this.baseUrl.includes("openrouter.ai") ? "images" : "images/generations";
    const response = await fetch(endpoint(this.baseUrl, path), {
      method: "POST",
      headers: headers(this.baseUrl, this.apiKey),
      body: JSON.stringify({
        model: this.imageModel,
        prompt,
        n: 1,
        quality: "medium",
        size: "1024x1024",
        output_format: "png",
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
    await assertOk(response);
    const payload = await response.json();
    const encoded = payload.data?.[0]?.b64_json;
    if (!encoded) throw new Error("The image model returned no image");
    return {
      buffer: Buffer.from(encoded, "base64"),
      mimeType: payload.data?.[0]?.media_type || "image/png",
      model: this.imageModel,
    };
  }

  async synthesize({ text, signal }) {
    if (!this.speechModel) throw new Error("Speech model is not configured");
    if (this.baseUrl.includes("openrouter.ai") && /gpt-audio/i.test(this.speechModel)) {
      return this.#synthesizeOpenRouterAudio({ text, signal });
    }
    // Fish Audio and other TTS models use the standard /audio/speech endpoint.
    const response = await fetch(endpoint(this.baseUrl, "audio/speech"), {
      method: "POST",
      headers: headers(this.baseUrl, this.apiKey),
      body: JSON.stringify({
        model: this.speechModel,
        input: text,
        voice: this.voice,
        response_format: "mp3",
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    await assertOk(response);
    return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: "audio/mpeg", model: this.speechModel };
  }

  async #synthesizeOpenRouterAudio({ text, signal }) {
    const response = await fetch(endpoint(this.baseUrl, "chat/completions"), {
      method: "POST",
      headers: headers(this.baseUrl, this.apiKey),
      body: JSON.stringify({
        model: this.speechModel,
        messages: [{ role: "user", content: text }],
        modalities: ["text", "audio"],
        audio: { voice: this.voice, format: "pcm16" },
        stream: true,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    await assertOk(response);
    if (!response.body) throw new Error("The speech model returned no stream");
    const decoder = new TextDecoder();
    let pending = "";
    const chunks = [];
    const consume = line => {
      if (!line.startsWith("data:")) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") return;
      const data = JSON.parse(raw).choices?.[0]?.delta?.audio?.data;
      if (data) chunks.push(Buffer.from(data, "base64"));
    };
    for await (const bytes of response.body) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      lines.forEach(consume);
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
    if (!chunks.length) throw new Error("The speech model returned no audio");
    const pcmBuffer = Buffer.concat(chunks);
    const wavBuffer = wrapPcm16InWav(pcmBuffer, 24000);
    return { buffer: wavBuffer, mimeType: "audio/wav", model: this.speechModel };
  }
}
