import { afterEach, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "../src/providers/openai-compatible.provider.js";
const provider = new OpenAiCompatibleProvider({
  baseUrl: "https://example.invalid",
  apiKey: "test",
  model: "test",
});
afterEach(() => vi.unstubAllGlobals());
function response(chunks) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              chunks.forEach((chunk) =>
                controller.enqueue(new TextEncoder().encode(chunk)),
              );
              controller.close();
            },
          }),
        ),
    ),
  );
}
it("reads split SSE frames and a final line without newline", async () => {
  response([
    'data: {"choices":[{"delta":{"content":"he',
    'llo"}}]}\r\n\r\ndata: [DONE]',
  ]);
  let text = "";
  for await (const chunk of provider.streamChat({ messages: [] }))
    text += chunk;
  expect(text).toBe("hello");
});
it("rejects a silent truncated stream", async () => {
  response(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']);
  await expect(async () => {
    for await (const _chunk of provider.streamChat({ messages: [] })) {
      /* consume */
    }
  }).rejects.toThrow("without completion");
});
it("rejects a length-limited reply", async () => {
  response(['data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n']);
  await expect(async () => {
    for await (const _chunk of provider.streamChat({ messages: [] })) {
      /* consume */
    }
  }).rejects.toThrow("truncated");
});
it("requests low verbosity from GPT-5 chat models", async () => {
  response(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']);
  const concise = new OpenAiCompatibleProvider({
    baseUrl: "https://example.invalid",
    apiKey: "test",
    model: "gpt-5-mini",
  });
  for await (const _chunk of concise.streamChat({ messages: [] })) {
    /* consume */
  }
  const options = fetch.mock.calls[0][1];
  expect(JSON.parse(options.body).verbosity).toBe("low");
});
it("accepts alternative valid finish reasons such as end_turn and eos", async () => {
  response([
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"end_turn"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  let text = "";
  for await (const chunk of provider.streamChat({ messages: [] }))
    text += chunk;
  expect(text).toBe("ok");
});
it("streams tool calls and allows tool_calls as a finish reason", async () => {
  response([
    'data: {"choices":[{"delta":{"content":"here.","tool_calls":[{"index":0,"id":"call_1","function":{"name":"send_photo","arguments":"{\\"what\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"park\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const chunks = [];
  for await (const chunk of provider.streamChat({
    messages: [],
    tools: [{ type: "function", function: { name: "send_photo" } }],
  })) {
    chunks.push(chunk);
  }
  expect(chunks[0]).toBe("here.");
  expect(chunks[1].toolCalls[0].function).toEqual({
    name: "send_photo",
    arguments: '{"what":"park"}',
  });
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.tools).toHaveLength(1);
  expect(body.tool_choice).toBe("auto");
});
it("passes a forced tool choice through to the provider", async () => {
  response([
    'data: {"choices":[{"delta":{"content":"here."},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  for await (const _chunk of provider.streamChat({
    messages: [],
    tools: [{ type: "function", function: { name: "send_photo" } }],
    toolChoice: { type: "function", function: { name: "send_photo" } },
  })) {
    /* consume */
  }
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.tool_choice).toEqual({ type: "function", function: { name: "send_photo" } });
});
it("injects OpenRouter headers and include_reasoning for OpenRouter base URL", async () => {
  response(['data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
  const openRouterProvider = new OpenAiCompatibleProvider({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-test-key",
    model: "openrouter/auto",
  });
  let text = "";
  for await (const chunk of openRouterProvider.streamChat({ messages: [] }))
    text += chunk;
  expect(text).toBe("hi");
  const call = fetch.mock.calls[0];
  const headers = call[1].headers;
  expect(headers["HTTP-Referer"]).toBe("https://lofn.ai");
  expect(headers["X-Title"]).toBe("Lofn Companion");
  const body = JSON.parse(call[1].body);
  expect(body.include_reasoning).toBe(false);
});
it("strips think tags from generateText output", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "<think>Let me think about this</think>Hello there!",
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  const text = await provider.generateText({ messages: [] });
  expect(text).toBe("Hello there!");
});
