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
