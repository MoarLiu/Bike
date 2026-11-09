import { compensateWorkspaceChange, initialPositions } from "../shared/bike-operations.mjs";
import type { OutlineDocument, Workspace } from "./types";
import { sameDocumentContent } from "./documentSignature";
import { withHistoryBudget } from "./historyBudget";
export { MAX_HISTORY_BYTES, historyMemoryUsage } from "./historyBudget";

export type HistorySelection = {
  documentId: string;
  nodeId: string | null;
};

export type HistoryDocumentChange = {
  id: string;
  before: OutlineDocument;
  after: OutlineDocument;
};

export type HistoryEntry = {
  group: string | null;
  label: string;
  at: number;
  changes: HistoryDocumentChange[];
  creations?: Array<{ document: OutlineDocument; index: number }>;
  beforeSelection: HistorySelection;
  afterSelection: HistorySelection;
};

export type EditHistory = {
  past: HistoryEntry[];
  future: HistoryEntry[];
};

export type RecordChangeInput = {
  history: EditHistory;
  before: Workspace;
  after: Workspace;
  selection: HistorySelection;
  afterSelection?: HistorySelection;
  label: string;
  group?: string | null;
  at?: number;
};

export type ApplyStepInput = {
  history: EditHistory;
  workspace: Workspace;
  now: string;
};

export type ApplyStepResult =
  | { status: "empty" }
  | { status: "stale"; label: string }
  | { status: "applied"; workspace: Workspace; entry: HistoryEntry; history: EditHistory };

export type EditOptions = {
  label?: string;
  group?: string | null;
  nodeId?: string | null;
};

const MAX_ENTRIES = 200;
const GROUP_INTERVAL_MS = 1500;

export const emptyEditHistory = (): EditHistory => ({ past: [], future: [] });

const documentChanges = (
  before: Workspace,
  after: Workspace,
): HistoryDocumentChange[] => {
  const afterById = new Map(after.documents.map((document) => [document.id, document]));
  const changes: HistoryDocumentChange[] = [];
  for (const document of before.documents) {
    const next = afterById.get(document.id);
    if (next && next !== document && !sameDocumentContent(document, next)) {
      changes.push({ id: document.id, before: document, after: next });
    }
  }
  return changes;
};

export const recordChange = ({
  history,
  before,
  after,
  selection,
  afterSelection = selection,
  label,
  group = null,
  at = Date.now(),
}: RecordChangeInput): EditHistory => {
  const changes = documentChanges(before, after);
  const beforeIds = new Set(before.documents.map((document) => document.id));
  const creations = after.documents.flatMap((document, index) => beforeIds.has(document.id) ? [] : [{ document, index }]);
  if (!changes.length && !creations.length) return history;

  const previous = history.past[history.past.length - 1];
  const canMerge =
    creations.length === 0 && !previous?.creations?.length &&
    group !== null &&
    Boolean(previous) &&
    history.future.length === 0 &&
    previous.group === group &&
    previous.changes.length === 1 &&
    changes.length === 1 &&
    previous.changes[0].id === changes[0].id &&
    at >= previous.at &&
    at - previous.at <= GROUP_INTERVAL_MS &&
    sameDocumentContent(previous.changes[0].after, changes[0].before);

  if (canMerge) {
    const previousChange = previous.changes[0];
    const nextChange = changes[0];
    return withHistoryBudget(history, {
      past: [
        ...history.past.slice(0, -1),
        {
          ...previous,
          at,
          label,
          afterSelection,
          changes: [{
            id: previousChange.id,
            before: previousChange.before,
            after: nextChange.after,
          }],
        },
      ],
      future: [],
    });
  }

  return withHistoryBudget(history, {
    past: [
      ...history.past,
      {
        group,
        label,
        at,
        changes,
        ...(creations.length ? { creations } : {}),
        beforeSelection: selection,
        afterSelection,
      },
    ].slice(-MAX_ENTRIES),
    future: [],
  });
};

const applyEntry = (
  entry: HistoryEntry,
  direction: "undo" | "redo",
  workspace: Workspace,
  now: string,
): Exclude<ApplyStepResult, { status: "applied" }> | {
  status: "applied";
  workspace: Workspace;
  entry: HistoryEntry;
} => {
  const currentById = new Map(
    workspace.documents.map((document) => [document.id, document]),
  );
  const creations = entry.creations ?? [];
  for (const { document } of creations) {
    const current = currentById.get(document.id);
    if (direction === "undo" ? !current || !sameDocumentContent(current, document) : Boolean(current)) return { status: "stale", label: entry.label };
  }
  if (direction === "undo" && workspace.documents.length <= creations.length) return { status: "stale", label: entry.label };
  if (workspace.version === 3 && entry.changes.length) {
    const before = { ...workspace, documents: entry.changes.map((change) => change.before) };
    const after = { ...workspace, documents: entry.changes.map((change) => change.after) };
    const expected = direction === "undo" ? after : before;
    const target = direction === "undo" ? before : after;
    const compensated = compensateWorkspaceChange(workspace, target, expected, {
      id: `history-${Date.now()}`, actorId: "history", clock: 1, positions: initialPositions(expected), source: { kind: direction, label: entry.label }, createdAt: now,
    });
    if (compensated.status !== "applied") return { status: "stale", label: entry.label };
    let documents = compensated.workspace.documents;
    if (direction === "undo") documents = documents.filter((document) => !creations.some((item) => item.document.id === document.id));
    else for (const item of creations) { documents = [...documents]; documents.splice(item.index, 0, item.document); }
    return { status: "applied", workspace: { ...compensated.workspace, documents }, entry };
  }
  for (const change of entry.changes) {
    const current = currentById.get(change.id);
    const expected = direction === "undo" ? change.after : change.before;
    if (!current || (current !== expected && !sameDocumentContent(current, expected))) {
      return { status: "stale", label: entry.label };
    }
  }

  const replacementById = new Map(
    entry.changes.map((change) => {
      const source = direction === "undo" ? change.before : change.after;
      return [change.id, {
        ...source,
        updatedAt: now,
        ...(source.markdownSource !== undefined ? { markdownUpdatedAt: now } : {}),
      }];
    }),
  );
  let documents = workspace.documents.map((document) => replacementById.get(document.id) ?? document);
  if (direction === "undo") documents = documents.filter((document) => !creations.some((item) => item.document.id === document.id));
  else for (const item of creations) { documents = [...documents]; documents.splice(item.index, 0, item.document); }

  return {
    status: "applied",
    workspace: { ...workspace, documents },
    entry,
  };
};

export const undo = ({
  history,
  workspace,
  now,
}: ApplyStepInput): ApplyStepResult => {
  const entry = history.past[history.past.length - 1];
  if (!entry) return { status: "empty" };
  const result = applyEntry(entry, "undo", workspace, now);
  if (result.status !== "applied") return result;
  return {
    ...result,
    history: withHistoryBudget(history, {
      past: history.past.slice(0, -1),
      future: [entry, ...history.future].slice(0, MAX_ENTRIES),
    }),
  };
};

export const redo = ({
  history,
  workspace,
  now,
}: ApplyStepInput): ApplyStepResult => {
  const entry = history.future[0];
  if (!entry) return { status: "empty" };
  const result = applyEntry(entry, "redo", workspace, now);
  if (result.status !== "applied") return result;
  return {
    ...result,
    history: withHistoryBudget(history, {
      past: [...history.past, entry].slice(-MAX_ENTRIES),
      future: history.future.slice(1),
    }),
  };
};
