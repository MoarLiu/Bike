import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/typescript.mjs";
const ai = loadTypescript("src/ai.ts");
const sync = loadTypescript("src/sync.ts");
const config = { endpoint: "responses", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model: "fixture" };
const context = { documentTitle: "Doc", topicText: "Topic" };
const install = (t, fetch) => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://localhost", hostname: "localhost", protocol: "http:" } };
  t.mock.method(globalThis, "fetch", fetch);
  t.after(() => { globalThis.window = previousWindow; });
};

test("AI and sync deadlines cover a response body that never finishes", async (t) => {
  let cancelled = 0;
  install(t, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"pending":')); }, cancel() { cancelled++; } })));
  await assert.rejects(ai.runAiNodeAction(config, "generate", context, { timeoutMs: 30 }), (error) => error.code === "timeout");
  await assert.rejects(sync.apiRequest({ serverUrl: "http://localhost", token: "" }, "/api/sync/manifest", { timeoutMs: 30 }), (error) => error.code === "timeout");
  assert.equal(cancelled, 2);
});

test("streaming response budgets do not depend on Content-Length", async (t) => {
  let cancelled = false;
  install(t, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4096)); }, cancel() { cancelled = true; } })));
  await assert.rejects(ai.runAiNodeAction(config, "generate", context, { maxResponseBytes: 128 }), (error) => error.code === "response-too-large");
  assert.equal(cancelled, true);
});

test("cancellation ends a non-cooperative provider and ignores its late answer", async (t) => {
  let release;
  install(t, () => new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const operation = ai.runAiNodeAction(config, "polish", context, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled by user"));
  await assert.rejects(operation, /cancelled by user/);
  release(new Response(JSON.stringify({ output_text: '{"text":"late answer"}' })));
});

test("AI parsing is bounded and polish uses the same Unicode-safe cleaning as generation", async (t) => {
  assert.throws(() => ai.firstBalancedJsonSlice("{".repeat(100_000)), /嵌套/);
  assert.equal(ai.firstBalancedJsonSlice('prefix {"text":"escaped \\\" ] }"} suffix'), '{"text":"escaped \\\" ] }"}');
  install(t, async () => new Response(JSON.stringify({ output_text: JSON.stringify({ text: "a".repeat(119) + "😀\u0001" }) })));
  const result = await ai.runAiNodeAction(config, "polish", context);
  assert.equal(Array.from(result.text).length, 120);
  assert.ok(result.text.endsWith("😀"));
});

test('AI outputs over the text, sibling or depth budget are rejected instead of truncated', async (t) => {
  let output = { text: 'a'.repeat(121) };
  install(t, async () => new Response(JSON.stringify({ output_text: JSON.stringify(output) })));
  await assert.rejects(ai.runAiNodeAction(config, 'polish', context), /120/);
  output = { children: Array.from({ length: 9 }, (_, index) => ({ text: `item ${index}` })) };
  await assert.rejects(ai.runAiNodeAction(config, 'generate', context), /8 项/);
  output = { children: [{ text: 'one', children: [{ text: 'two', children: [{ text: 'three', children: [{ text: 'four' }] }] }] }] };
  await assert.rejects(ai.runAiNodeAction(config, 'generate', context), /3 层/);
});
