import type { OutlineDocument, TrashEntry, Workspace } from "./types";
import { uuid } from "./id";
import { flattenNodes } from "./tree";
import { remapCollidingIds, knowledgeEditable } from "./knowledge";

export const TRASH_LIMIT = 100;
export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const now = () => new Date().toISOString();

export const pruneTrash = (
  trash: TrashEntry[] = [],
  at: number = Date.now(),
): TrashEntry[] =>
  trash.filter((entry) => at - Date.parse(entry.deletedAt) < TRASH_TTL_MS);

export const moveDocumentToTrash = (
  workspace: Workspace,
  documentId: string,
): { workspace: Workspace; entry: TrashEntry } | null => {
  const index = workspace.documents.findIndex((document) => document.id === documentId);
  if (index === -1 || workspace.documents.length <= 1) return null;

  const document = workspace.documents[index];
  const entry: TrashEntry = {
    id: `trash_${uuid()}`,
    document,
    deletedAt: now(),
    originalIndex: index,
  };
  const documents = workspace.documents.filter((item) => item.id !== documentId);
  return {
    workspace: {
      ...workspace,
      activeDocumentId:
        workspace.activeDocumentId === documentId
          ? documents[0].id
          : workspace.activeDocumentId,
      documents,
      trash: pruneTrash([entry, ...(workspace.trash ?? [])]).slice(0, TRASH_LIMIT),
    },
    entry,
  };
};
export const restoreTrashEntry = (
  workspace: Workspace,
  entryId: string,
): { workspace: Workspace; document: OutlineDocument } | null => {
  const entry = workspace.trash?.find((item) => item.id === entryId);
  if (!entry) return null;

  const idCollision = workspace.documents.some(
    (document) => document.id === entry.document.id,
  );
  const liveNodeIds = new Set(workspace.documents.flatMap((document) =>
    flattenNodes(document.nodes).map((row) => row.node.id),
  ));
  const nodeCollision = flattenNodes(entry.document.nodes).some((row) =>
    liveNodeIds.has(row.node.id),
  );
  if ((idCollision || nodeCollision) && entry.document.knowledge && !knowledgeEditable(entry.document.knowledge)) {
    throw new Error("恢复时发现身份冲突，当前版本无法安全更新这份知识数据；原副本仍保留在回收站，可先导出 JSON");
  }
  const usedIds = new Set([...liveNodeIds, ...workspace.documents.map((document) => document.id)]);
  const remapped = idCollision || nodeCollision ? remapCollidingIds(entry.document, usedIds).document : entry.document;
  const restored = {
    ...remapped,
    ...(idCollision ? { title: `${entry.document.title}（恢复）` } : {}),
    updatedAt: now(),
    ...((idCollision || nodeCollision) ? { markdownSource: undefined, markdownUpdatedAt: undefined } : {}),
  };

  const insertIndex = Math.min(entry.originalIndex, workspace.documents.length);
  const documents = [...workspace.documents];
  documents.splice(insertIndex, 0, restored);
  return {
    workspace: {
      ...workspace,
      activeDocumentId: restored.id,
      documents,
      trash: (workspace.trash ?? []).filter((item) => item.id !== entryId),
    },
    document: restored,
  };
};

export const removeTrashEntry = (
  workspace: Workspace,
  entryId: string,
): Workspace => ({
  ...workspace,
  trash: (workspace.trash ?? []).filter((item) => item.id !== entryId),
});

export const emptyTrash = (workspace: Workspace): Workspace => ({
  ...workspace,
  trash: [],
});

export const retainLocalTrash = (before: Workspace, after: Workspace): Workspace => {
  const liveIds = new Set(after.documents.map((document) => document.id));
  const deletedAt = now();
  const removed = before.documents.flatMap((document, originalIndex) =>
    liveIds.has(document.id) ? [] : [{
      id: `trash_${uuid()}`,
      document,
      deletedAt,
      originalIndex,
    }],
  );
  if (!removed.length && before.trash === undefined) return after;
  if (!removed.length) {
    const retained = pruneTrash(before.trash);
    if (retained.length === before.trash?.length) {
      return after.trash === before.trash ? after : { ...after, trash: before.trash };
    }
  }
  return {
    ...after,
    trash: pruneTrash([...removed, ...(before.trash ?? [])]).slice(0, TRASH_LIMIT),
  };
};
