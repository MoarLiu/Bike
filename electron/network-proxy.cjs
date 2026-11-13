let network;
const requestJson = async ({ url, method = "GET", headers = {}, body, signal, timeoutMs, maxBytes, requireJson = false }) => {
  network ??= import("../shared/bike-network.mjs");
  const { withRequestBudget, readResponseText } = await network;
  return withRequestBudget({ timeoutMs, signal }, async (requestSignal) => {
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: requestSignal, redirect: "error" });
    const text = await readResponseText(response, { signal: requestSignal, maxBytes });
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch {
        if (response.ok && requireJson) throw new Error("同步服务返回了无效 JSON");
        data = requireJson ? { message: text.slice(0, 500) } : { text };
      }
    }
    return { ok: response.ok, status: response.status, contentType: response.headers.get("content-type") || "", data };
  });
};
module.exports = { requestJson };
