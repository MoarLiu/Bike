// Markdown links and images are rendered as real <a href> / <img src>, so their
// URLs must be checked the way the browser will parse them. The WHATWG URL
// parser drops leading/trailing C0 controls and spaces and removes tab/newline
// characters anywhere, so "java\tscript:" or "\u0001javascript:" still runs as
// javascript:. Normalize first, then let URL() decide the scheme.
const URL_TAB_OR_NEWLINE = /[\t\n\r]/g;
const URL_EDGE_CONTROLS = /^[\u0000- ]+|[\u0000- ]+$/g;
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
// Relative references (paths, #anchors) resolve against this placeholder.
const RELATIVE_BASE = "https://bike.invalid/";

export const safeMarkdownUrl = (value: string, kind: "link" | "image") => {
  const normalized = value
    .replace(URL_TAB_OR_NEWLINE, "")
    .replace(URL_EDGE_CONTROLS, "")
    .trim();
  if (!normalized) return "";
  let protocol: string;
  try {
    protocol = new URL(normalized, RELATIVE_BASE).protocol;
  } catch {
    return "";
  }
  if (SAFE_LINK_PROTOCOLS.has(protocol)) return normalized;
  if (kind === "image" && protocol === "data:" && /^data:image\//i.test(normalized)) {
    return normalized;
  }
  return "";
};
