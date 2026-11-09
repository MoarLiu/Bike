export const AI_TIMEOUT_MS = 90_000;
export const SYNC_TIMEOUT_MS = 60_000;
export const MAX_AI_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_SYNC_RESPONSE_BYTES = 80 * 1024 * 1024;

export class BikeRequestError extends Error {
  constructor(message, code) { super(message); this.name = "BikeRequestError"; this.code = code; }
}
const cancellation = () => new BikeRequestError("请求已取消", "cancelled");

// The deadline covers headers, streaming body reads and parsing. The race also
// handles providers/fakes that fail to honor AbortSignal themselves.
export const withRequestBudget = async ({ timeoutMs, signal: externalSignal }, work) => {
  const controller = new AbortController();
  const cancel = () => controller.abort(externalSignal?.reason ?? cancellation());
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason ?? cancellation());
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  externalSignal?.addEventListener("abort", cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new BikeRequestError(`请求超过 ${timeoutMs / 1000} 秒，已停止等待`, "timeout")), timeoutMs);
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }), aborted]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
};

export const readResponseText = async (response, { maxBytes, signal }) => {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body?.cancel?.().catch(() => {});
    throw new BikeRequestError(`响应超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB，已停止读取`, "response-too-large");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    signal?.throwIfAborted();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new BikeRequestError("响应超过读取预算", "response-too-large");
    return text;
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  const parts = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new BikeRequestError(`响应超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB，已停止读取`, "response-too-large");
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
};
