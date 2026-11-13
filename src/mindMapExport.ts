import { downloadBlob } from "./exporters";
import { loadAttachmentImage } from "./attachmentImages";
import { isPreviewableImage } from "../shared/bike-attachments.mjs";
import { xmlText } from "./xmlText";
import type { OutlineDocument } from "./types";

const namespace = "http://www.w3.org/2000/svg";
const element = (name: string, attributes: Record<string, string | number>) => {
  const node = document.createElementNS(namespace, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

export const exportMindMap = async (outline: OutlineDocument, format: "svg" | "png", transparent = false) => {
  const current = document.querySelector<SVGSVGElement>("svg.mindmap");
  if (!current) throw new Error("请切换到脑图后导出");
  const bounds = current.getBBox();
  const width = Math.ceil(bounds.width + 48);
  const height = Math.ceil(bounds.height + 48);
  if (format === "png" && (width * height > 32_000_000 || width > 16_384 || height > 16_384)) throw new Error("PNG 超过输出尺寸预算，请折叠部分主题或导出 SVG");
  const svg = element("svg", { xmlns: namespace, width, height, viewBox: `${bounds.x - 24} ${bounds.y - 24} ${width} ${height}` });
  if (!transparent) svg.append(element("rect", { x: bounds.x - 24, y: bounds.y - 24, width, height, fill: getComputedStyle(document.body).backgroundColor || "white" }));
  // Snapshot all layout content before asynchronous image reads.
  const cards = [...current.querySelectorAll<SVGForeignObjectElement>("foreignObject.map-node-object")].map((source) => {
    const card = source.querySelector<HTMLElement>(".map-node")!;
    const style = getComputedStyle(card);
    const id = source.dataset.nodeId;
    const group = element("g", {});
    const x = Number(source.getAttribute("x")), y = Number(source.getAttribute("y"));
    const w = Number(source.getAttribute("width")), h = Number(source.getAttribute("height"));
    group.append(element("rect", { x, y, width: w, height: h, rx: 8, fill: style.backgroundColor, stroke: style.borderColor }));
    const lines = [...card.querySelectorAll(".map-node-lines > span")].map((node) => node.textContent || "");
    if (!lines.length) lines.push(card.querySelector("textarea")?.value || "");
    lines.forEach((line, index) => {
      const text = element("text", { x: x + w / 2, y: y + 24 + index * 19, "text-anchor": "middle", fill: style.color, "font-size": 14, "font-family": "-apple-system, PingFang SC, Noto Sans CJK SC, sans-serif" });
      text.textContent = line;
      group.append(text);
    });
    return { id, group, x, y, w, h, lines: lines.length };
  });
  for (const source of [...current.children]) {
    if (source.tagName.toLowerCase() === "foreignobject") continue;
    const copy = source.cloneNode(true) as SVGElement;
    const sources = [source, ...source.querySelectorAll("*")];
    const copies = [copy, ...copy.querySelectorAll("*")];
    sources.forEach((node, index) => {
      const style = getComputedStyle(node);
      for (const key of ["stroke", "stroke-width", "stroke-dasharray", "fill", "color", "font-size", "font-family"]) {
        copies[index].setAttribute(key, style.getPropertyValue(key));
      }
    });
    svg.append(copy);
  }
  const nodes = new Map<string, typeof outline.nodes[number]>();
  const stack = [...outline.nodes];
  while (stack.length) { const node = stack.pop()!; nodes.set(node.id, node); stack.push(...node.children); }
  const images = new Map<string, string>();
  let imageBytes = 0;
  for (const card of cards) {
    const reference = nodes.get(card.id || "")?.attachmentRefs?.[0];
    if (reference) {
      const metadata = outline.attachments?.items[reference.assetId];
      if (isPreviewableImage(metadata)) {
        let url = images.get(reference.assetId);
        if (!url) {
          const image = await loadAttachmentImage(reference.assetId);
          imageBytes += image.metadata.byteLength;
          if (imageBytes > 128 * 1024 * 1024) throw new Error("SVG 图片超过 128 MiB 预算，请缩小导出范围");
          url = image.dataUrl;
          images.set(reference.assetId, url);
        }
        card.group.append(element("image", { x: card.x + 12, y: card.y + card.lines * 19 + 30, width: card.w - 24, height: 76, href: url, preserveAspectRatio: "xMidYMid meet" }));
      }
      const label = element("text", { x: card.x + card.w / 2, y: card.y + card.h - 12, "text-anchor": "middle", fill: "#666", "font-size": 11 });
      label.textContent = reference.name;
      card.group.append(label);
    }
    svg.append(card.group);
  }
  const content = xmlText(new XMLSerializer().serializeToString(svg));
  const blob = new Blob([content], { type: "image/svg+xml" });
  const filename = outline.title.replace(/[/\\:*?"<>|]/gu, "_").slice(0, 100) || "mindmap";
  if (format === "svg") { downloadBlob(`${filename}.svg`, blob); return; }
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const image = new Image();
  const canvas = document.createElement("canvas");
  try {
    image.src = url;
    await image.decode();
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建 PNG 画布");
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG 编码失败")), "image/png"));
    downloadBlob(`${filename}.png`, png);
  } catch (error) {
    throw new Error(`PNG 导出失败，请检查图片或改用 SVG：${error instanceof Error ? error.message : "图片无法解码"}`);
  } finally { image.src = ""; canvas.width = 0; canvas.height = 0; }
};
