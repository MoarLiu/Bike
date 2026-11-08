const editCommandForInput = (input) => {
  if (input.type !== "keyDown" || input.isComposing || input.alt) return null;
  if (!input.meta && !input.control) return null;
  const key = String(input.key).toLowerCase();
  if (key === "z") return input.shift ? "redo" : "undo";
  if (key === "y" && input.control) return "redo";
  return null;
};

module.exports = { editCommandForInput };
