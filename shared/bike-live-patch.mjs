import { canonicalJson } from "./bike-operations.mjs";

// A proposal is relative to the read barrier's exact revision. Unchanged
// documents stay on the application side, including their original identities.
export const createLiveCandidatePatch = (before, after) => {
  const previous = new Map(before.documents.map((document) => [document.id, document]));
  return {
    documents: after.documents.filter((document) => canonicalJson(previous.get(document.id) ?? null) !== canonicalJson(document)),
    documentOrder: after.documents.map((document) => document.id),
    activeDocumentId: after.activeDocumentId,
  };
};

export const applyLiveCandidatePatch = (before, patch) => {
  if (!patch || !Array.isArray(patch.documents) || !Array.isArray(patch.documentOrder) ||
      patch.documentOrder.some((id) => typeof id !== "string" || !id) ||
      new Set(patch.documentOrder).size !== patch.documentOrder.length) throw new Error("Live 提案文档顺序无效");
  const documents = new Map(before.documents.map((document) => [document.id, document]));
  const seen = new Set();
  for (const document of patch.documents) {
    if (!document || typeof document.id !== "string" || seen.has(document.id) || !patch.documentOrder.includes(document.id)) throw new Error("Live 提案包含无效或重复文档");
    seen.add(document.id);
    documents.set(document.id, document);
  }
  const ordered = patch.documentOrder.map((id) => {
    const document = documents.get(id);
    if (!document) throw new Error("Live 提案缺少文档内容");
    return document;
  });
  if (!ordered.length || !patch.documentOrder.includes(patch.activeDocumentId)) throw new Error("Live 提案活动文档无效");
  return { ...before, documents: ordered, activeDocumentId: patch.activeDocumentId };
};
