import type { OutlineDocument } from "./types";
import { migrateDocument } from "./migrations";

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stableValue(item)])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
  }
  return value;
};

export const documentSignature = (document: OutlineDocument): string => {
  const { updatedAt, markdownUpdatedAt, ...content } = migrateDocument(document);
  return JSON.stringify(stableValue(content));
};

export const sameDocumentContent = (
  left: OutlineDocument,
  right: OutlineDocument,
) => documentSignature(left) === documentSignature(right);
