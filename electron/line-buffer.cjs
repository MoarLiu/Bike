// Newline-delimited IPC frames without quadratic Buffer.concat on large
// documents. Each received byte is scanned once and copied at most once.
const createLineBuffer = (maximum) => {
  let parts = [], length = 0;
  return {
    push(chunk) {
      const lines = [];
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        if (length + part.length > maximum) throw new Error("IPC frame exceeds budget");
        if (part.length) { parts.push(part); length += part.length; }
        if (newline < 0) break;
        lines.push(parts.length === 1 ? parts[0] : Buffer.concat(parts, length));
        parts = []; length = 0; offset = newline + 1;
      }
      return lines;
    },
  };
};
module.exports = { createLineBuffer };
