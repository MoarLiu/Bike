export const ATTACHMENT_VERSION = 1;
export const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMPORT_FILES = 100;
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

const assetPattern = /^sha256:[a-f0-9]{64}$/u;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const attachmentDigest = (assetId) => {
  if (typeof assetId !== "string" || !assetPattern.test(assetId)) {
    throw new Error("附件标识无效，原数据已保留");
  }
  return assetId.slice(7);
};

/** @returns {{ mediaType: string, byteLength: number, width?: number, height?: number }} */
export const validateAttachmentMetadata = (metadata) => {
  if (!record(metadata) ||
      !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0 ||
      metadata.byteLength > MAX_ATTACHMENT_BYTES ||
      typeof metadata.mediaType !== "string" ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(metadata.mediaType)) {
    throw new Error("附件元数据无效或超过大小预算，原数据已保留");
  }
  for (const key of ["width", "height"]) {
    if (metadata[key] !== undefined &&
        (!Number.isSafeInteger(metadata[key]) || metadata[key] < 1 || metadata[key] > 0xffffffff)) {
      throw new Error("附件图片尺寸无效，原数据已保留");
    }
  }
  if (["image/png", "image/jpeg", "image/webp"].includes(metadata.mediaType) &&
      (metadata.width === undefined || metadata.height === undefined)) {
    throw new Error("附件图片缺少尺寸，原数据已保留");
  }
  return metadata;
};

export const collectAttachmentRefs = (nodes) => {
  const refs = [];
  const stack = [...(nodes ?? [])];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!record(node) || seen.has(node)) throw new Error("附件主题结构无效，原数据已保留");
    seen.add(node);
    if (node.attachmentRefs !== undefined) {
      if (!Array.isArray(node.attachmentRefs)) throw new Error("主题附件引用无效，原数据已保留");
      for (const ref of node.attachmentRefs) {
        if (!record(ref)) throw new Error("主题附件引用无效，原数据已保留");
        attachmentDigest(ref.assetId);
        if (typeof ref.name !== "string" || !ref.name.trim() || ref.name.length > 1024 ||
            (ref.alt !== undefined && (typeof ref.alt !== "string" || ref.alt.length > 10_000))) {
          throw new Error("附件显示名或替代文字无效，原数据已保留");
        }
        refs.push(ref);
      }
    }
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return refs;
};

export const validateDocumentAttachments = (document) => {
  const refs = collectAttachmentRefs(document.nodes);
  const manifest = document.attachments;
  if (manifest === undefined) {
    if (refs.length) throw new Error("文档缺少附件清单，原数据已保留");
    return;
  }
  if (!record(manifest) || manifest.version !== ATTACHMENT_VERSION || !record(manifest.items)) {
    throw new Error("附件格式版本暂不支持或清单无效，原数据已保留");
  }
  for (const [assetId, metadata] of Object.entries(manifest.items)) {
    attachmentDigest(assetId);
    validateAttachmentMetadata(metadata);
  }
  for (const ref of refs) {
    if (!Object.prototype.hasOwnProperty.call(manifest.items, ref.assetId)) {
      throw new Error(`附件 ${ref.name} 缺少元数据，原数据已保留`);
    }
  }
};

export const workspaceAttachmentAssets = (workspace) => {
  const assets = new Map();
  const documents = [
    ...(workspace.documents ?? []),
    ...(workspace.trash ?? []).map((entry) => entry.document),
  ];
  for (const document of documents) {
    validateDocumentAttachments(document);
    for (const ref of collectAttachmentRefs(document.nodes)) {
      const metadata = document.attachments.items[ref.assetId];
      const existing = assets.get(ref.assetId);
      if (existing && ["byteLength", "mediaType", "width", "height"].some((key) => existing[key] !== metadata[key])) {
        throw new Error("相同附件摘要对应的元数据不一致，原数据已保留");
      }
      assets.set(ref.assetId, metadata);
    }
  }
  return [...assets].map(([assetId, metadata]) => ({ assetId, metadata }));
};

export const workspaceFormatVersion = (workspace) => {
  if (workspace.version !== undefined && workspace.version !== 1 && workspace.version !== 2 && workspace.version !== 3) {
    throw new Error(`工作区版本 ${String(workspace.version)} 暂不支持，原数据已保留`);
  }
  if (workspace.version === 3) return 3;
  const documents = [...workspace.documents, ...(workspace.trash ?? []).map((entry) => entry.document)];
  return workspace.version === 2 || documents.some((document) => document.attachments !== undefined ||
    collectAttachmentRefs(document.nodes).length > 0) ? 2 : 1;
};

export const mergeAttachmentMetadata = (target, source) => {
  if (!source?.attachments) return target;
  validateDocumentAttachments(source);
  const items = { ...(target.attachments?.items ?? {}) };
  for (const [assetId, metadata] of Object.entries(source.attachments.items)) {
    const existing = items[assetId];
    if (existing && ["byteLength", "mediaType", "width", "height"].some((key) => existing[key] !== metadata[key])) {
      throw new Error("附件元数据冲突，原数据已保留");
    }
    items[assetId] = metadata;
  }
  return { ...target, attachments: { ...target.attachments, version: ATTACHMENT_VERSION, items } };
};

export const isPreviewableImage = (metadata) =>
  ["image/png", "image/jpeg", "image/webp"].includes(metadata?.mediaType) &&
  metadata.byteLength <= MAX_IMAGE_BYTES &&
  Number.isSafeInteger(metadata.width) && metadata.width > 0 &&
  Number.isSafeInteger(metadata.height) && metadata.height > 0 &&
  metadata.width * metadata.height <= MAX_IMAGE_PIXELS;
