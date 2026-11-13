import type { PDFFont } from "pdf-lib";

const characterSets = new WeakMap<PDFFont, Set<number>>();
const fallbacks = new WeakMap<PDFFont, PDFFont[]>();
const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locale?: string, options?: { granularity: string }) => {
  segment(text: string): Iterable<{ segment: string }>;
} }).Segmenter;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;
export const pdfGraphemes = (text: string): string[] => segmenter ? Array.from(segmenter.segment(text), item => item.segment) : Array.from(text);
const covers = (font: PDFFont, text: string) => {
  let characters = characterSets.get(font);
  if (!characters) { characters = new Set(font.getCharacterSet()); characterSets.set(font, characters); }
  return Array.from(text).every(character => {
    const code = character.codePointAt(0)!;
    return code === 0x200d || code === 0xfe0f || code === 0xfe0e || characters!.has(code);
  });
};
export const setPdfFallbackFonts = (primary: PDFFont, fonts: PDFFont[]) => fallbacks.set(primary, fonts);
export const pdfFontFor = (primary: PDFFont, text: string) =>
  [primary, ...(fallbacks.get(primary) ?? [])].find(font => covers(font, text));
export const pdfFontRuns = (text: string, primary: PDFFont): Array<{ text: string; font: PDFFont }> => {
  const runs: Array<{ text: string; font: PDFFont }> = [];
  for (const character of pdfGraphemes(text)) {
    const font = pdfFontFor(primary, character) ?? primary;
    const previous = runs[runs.length - 1];
    if (previous?.font === font) previous.text += character;
    else runs.push({ text: character, font });
  }
  return runs.length ? runs : [{ text: "", font: primary }];
};
export const pdfTextWidth = (text: string, primary: PDFFont, size: number) =>
  pdfFontRuns(text, primary).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0);
