import type { AttachmentMetadata } from "../shared/bike-attachments.mjs";

export const loadAttachmentImage = async (assetId: string) => {
  const read = (window.bike ?? window.localOutline)?.readAttachment;
  if (!read) throw new Error("此环境无法读取图片附件，请使用桌面版导出");
  const result = await read(assetId, false);
  if (!result.ok || !result.dataUrl || !result.metadata) throw new Error(result.error || "所需图片缺失或无法预览，请先补齐附件");
  return { dataUrl: result.dataUrl, metadata: result.metadata };
};

export const rasterImageBytes = async (image: { dataUrl: string; metadata: AttachmentMetadata }) => {
  let url = image.dataUrl;
  if (image.metadata.mediaType === "image/webp") {
    const decoded = new Image();
    decoded.src = url;
    await decoded.decode();
    const canvas = document.createElement("canvas");
    canvas.width = decoded.naturalWidth;
    canvas.height = decoded.naturalHeight;
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建图片转换画布");
      context.drawImage(decoded, 0, 0);
      url = canvas.toDataURL("image/png");
    } finally { canvas.width = 0; canvas.height = 0; decoded.src = ""; }
  }
  return Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (character) => character.charCodeAt(0));
};
