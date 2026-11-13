export interface MarkdownInlineToken { index: number; end: number; groups: Array<string | undefined> }

// Match bracket pairs once. An unmatched '[' must not scan the remainder of
// the line again at every position. Source offsets remain UTF-16 offsets.
export const markdownInlineTokens = (text: string): MarkdownInlineToken[] => {
  if (text.length > 1_000_000) return []; // very large lines remain plain text
  const bracket: number[] = [], paren: number[] = [], ends = new Map<number, number>();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") bracket.push(i);
    else if (c === "]" && bracket.length) ends.set(bracket.pop()!, i);
    else if (c === "(") paren.push(i);
    else if (c === ")" && paren.length) ends.set(paren.pop()!, i);
  }
  const styles = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_/y;
  const tokens: MarkdownInlineToken[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === "\\") { i += 2; continue; }
    const image = text[i] === "!" && text[i + 1] === "[";
    const opening = image ? i + 1 : i;
    if (text[opening] === "[") {
      const labelEnd = ends.get(opening);
      const urlEnd = labelEnd === undefined ? undefined : ends.get(labelEnd + 1);
      if (labelEnd !== undefined && text[labelEnd + 1] === "(" && urlEnd !== undefined) {
        const label = text.slice(opening + 1, labelEnd), destination = text.slice(labelEnd + 2, urlEnd);
        if ((image || label) && destination && !/\s/u.test(destination)) {
          const groups: Array<string | undefined> = [];
          groups[0] = text.slice(i, urlEnd + 1);
          groups[image ? 2 : 4] = label; groups[image ? 3 : 5] = destination;
          tokens.push({ index: i, end: urlEnd + 1, groups });
          i = urlEnd + 1; continue;
        }
      }
    }
    if ("`*_~".includes(text[i])) {
      const marker = text[i], width = text[i + 1] === marker && marker !== "`" ? 2 : 1;
      const previous = text[i - 1] ?? "", following = text[i + width] ?? "";
      if (marker !== "`" && (!following || /\s/u.test(following) ||
          (marker === "_" && /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(following)) ||
          (marker === "*" && width === 1 && /\d/u.test(previous) && /\d/u.test(following)))) { i += width; continue; }
      styles.lastIndex = i;
      const match = styles.exec(text);
      if (match) {
        const before = text[i - 1] ?? "", after = text[styles.lastIndex] ?? "";
        const wordUnderscore = (match[3] !== undefined || match[6] !== undefined) && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after);
        const arithmetic = match[5] !== undefined && /\d/u.test(before) && /\d/u.test(after);
        if (!wordUnderscore && !arithmetic) {
          const groups: Array<string | undefined> = [];
          groups[0] = match[0];
          for (let group = 1; group <= 6; group++) groups[group + 5] = match[group];
          tokens.push({ index: i, end: styles.lastIndex, groups });
          i = styles.lastIndex; continue;
        }
      }
    }
    i++;
  }
  return tokens;
};
