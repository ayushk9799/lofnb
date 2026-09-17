function endpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}/${path}`;
}
function getHeaders(baseUrl, apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (baseUrl && baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://lofn.ai";
    headers["X-Title"] = "Lofn Companion";
  }
  return headers;
}
function stripThinking(text = "") {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
async function assertResponse(response) {
  if (response.ok) return;
  const body = await response.text();
  throw new Error(
    `Model provider returned ${response.status}: ${body.slice(0, 500)}`,
  );
}
function extractJson(value) {
  const withoutFence = stripThinking(value)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model did not return a JSON object");
  }
  return JSON.parse(withoutFence.slice(start, end + 1));
}
function isReasoningModel(model = "") {
  return /(?:^|\/)(?:gpt-5|o1|o3|o4)/i.test(model);
}
function reasoningOff() {
  return { verbosity: "low", reasoning: { effort: "none" } };
}
export class OpenAiCompatibleProvider {
  name = "openai-compatible";
  model;
  baseUrl;
  apiKey;
  constructor(options) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
  }
  async *streamChat({ messages, tools, toolChoice, signal }) {
    const reasoning = isReasoningModel(this.model);
    const isOpenRouter = Boolean(this.baseUrl && this.baseUrl.includes("openrouter.ai"));
    const response = await fetch(endpoint(this.baseUrl, "chat/completions"), {
      method: "POST",
      headers: getHeaders(this.baseUrl, this.apiKey),
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        ...(Array.isArray(tools) && tools.length
          ? { tools, tool_choice: toolChoice || "auto", parallel_tool_calls: false }
          : {}),
        ...(isOpenRouter && !reasoning ? { include_reasoning: false } : {}),
        ...(reasoning
          ? reasoningOff()
          : {
              temperature: 0.7,
              presence_penalty: 0,
              frequency_penalty: 0.2,
            }),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    await assertResponse(response);
    if (!response.body) throw new Error("Model provider returned no stream");
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    const toolParts = new Map();
    const ingestToolDelta = (parts = []) => {
      for (const part of parts) {
        const index = Number.isInteger(part.index) ? part.index : 0;
        const current = toolParts.get(index) || { id: "", name: "", arguments: "" };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) current.arguments += part.function.arguments;
        toolParts.set(index, current);
      }
    };
    const parse = (line) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === "[DONE]") {
        finished = true;
        return;
      }
      const parsed = JSON.parse(payload);
      if (parsed.error) throw new Error("Provider stream failed");
      const choice = parsed.choices?.[0];
      const validStopReasons = ["stop", "end_turn", "eos", "tool_calls"];
      if (choice?.finish_reason && !validStopReasons.includes(choice.finish_reason))
        throw new Error("Provider reply was truncated or blocked");
      if (choice?.finish_reason && validStopReasons.includes(choice.finish_reason)) finished = true;
      if (choice?.delta?.tool_calls) ingestToolDelta(choice.delta.tool_calls);
      if (choice?.message?.tool_calls) ingestToolDelta(choice.message.tool_calls);
      return choice?.delta?.content;
    };
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const content = parse(line);
        if (content) yield content;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const content = parse(buffer);
      if (content) yield content;
    }
    if (!finished) throw new Error("Provider stream ended without completion");
    if (toolParts.size) {
      yield {
        toolCalls: [...toolParts.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, part]) => ({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: part.arguments },
          }))
          .filter((call) => call.function.name),
      };
    }
  }
  async generateJson({ messages, signal }) {
    const reasoning = isReasoningModel(this.model);
    const response = await fetch(endpoint(this.baseUrl, "chat/completions"), {
      method: "POST",
      headers: getHeaders(this.baseUrl, this.apiKey),
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        response_format: { type: "json_object" },
        ...(reasoning ? reasoningOff() : { temperature: 0 }),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    await assertResponse(response);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("Model provider returned empty JSON content");
    return extractJson(content);
  }
  async generateText({ messages, signal, temperature = 0.85 }) {
    const reasoning = isReasoningModel(this.model);
    const response = await fetch(endpoint(this.baseUrl, "chat/completions"), {
      method: "POST",
      headers: getHeaders(this.baseUrl, this.apiKey),
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        ...(reasoning ? reasoningOff() : { temperature }),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    await assertResponse(response);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("Model provider returned empty content");
    return stripThinking(content);
  }
}
export class OpenAiCompatibleEmbeddingProvider {
  model;
  baseUrl;
  apiKey;
  dimensions;
  constructor(options) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }
  async embed(text, signal) {
    const response = await fetch(endpoint(this.baseUrl, "embeddings"), {
      method: "POST",
      headers: getHeaders(this.baseUrl, this.apiKey),
      body: JSON.stringify({ model: this.model, input: text }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    await assertResponse(response);
    const payload = await response.json();
    const embedding = payload.data?.[0]?.embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length !== this.dimensions ||
      !embedding.every(Number.isFinite)
    ) {
      throw new Error(
        `Embedding dimensions mismatch: expected ${this.dimensions}, received ${embedding?.length ?? 0}`,
      );
    }
    return embedding;
  }
}
export function buildExtractionMessages(system, user) {
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
