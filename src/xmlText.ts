export const xmlText = (value: string) => Array.from(value).map((character) => {
  const code = character.codePointAt(0)!;
  return code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff) ? character : "�";
}).join("");
