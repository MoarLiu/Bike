const isTrustedIpcSender = (event, window, isAllowedUrl) => {
  if (!window || window.webContents.isDestroyed() || event?.sender !== window.webContents) return false;
  const frame = event.senderFrame, main = window.webContents.mainFrame;
  if (!frame || !main || (frame !== main && (frame.routingId !== main.routingId || frame.processId !== main.processId))) return false;
  return isAllowedUrl(frame.url || event.sender.getURL());
};
const normalizedEndpoint = (value) => {
  const url = new URL(String(value ?? "").trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("服务地址需要使用有效的 HTTP 或 HTTPS 地址");
  url.hash = "";
  return url.toString().replace(/\/+$/u, "");
};
const configuredNetworkRequest = (kind, payload, saved) => {
  if (!saved || typeof saved !== "object") throw new Error("请先保存服务配置后再发起请求");
  const field = kind === "ai" ? "baseUrl" : "serverUrl";
  if (normalizedEndpoint(payload[field]) !== normalizedEndpoint(saved[field])) throw new Error("请求地址与已保存的服务配置不一致");
  if (kind === "ai" && (payload.endpoint !== saved.endpoint || String(payload.apiKey ?? "").trim() !== String(saved.apiKey ?? "").trim())) throw new Error("AI 请求与已保存的配置不一致");
  if (kind === "sync" && String(payload.token ?? "").trim() !== String(saved.token ?? "").trim()) throw new Error("同步请求与已保存的配置不一致");
  return true;
};
const safeReleaseUrl = (value, fallback = "https://github.com/MoarLiu/Bike/releases") => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && /^\/MoarLiu\/Bike\/releases(?:\/|$)/iu.test(url.pathname)) return url.href;
  } catch { /* Use the owning project's release page. */ }
  return fallback;
};
module.exports = { isTrustedIpcSender, configuredNetworkRequest, safeReleaseUrl };
