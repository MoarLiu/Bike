// `inert` is not implemented by every supported WebKit host. Capture input
// events as well so an asynchronous atomic commit cannot accept new drafts.
export const lockWorkspaceInteraction = (shell: HTMLElement | null): (() => void) => {
  if (!shell) return () => {};
  const previous = shell.inert;
  const focused = shell.ownerDocument.activeElement;
  const events = ["beforeinput", "keydown", "pointerdown", "paste", "drop", "compositionstart"] as const;
  const stop = (event: Event) => {
    if (event.target instanceof Node && shell.contains(event.target)) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  for (const event of events) shell.ownerDocument.addEventListener(event, stop, true);
  shell.inert = true;
  return () => {
    shell.inert = previous;
    for (const event of events) shell.ownerDocument.removeEventListener(event, stop, true);
    if (!previous && focused instanceof HTMLElement && focused.isConnected && shell.contains(focused) &&
        (!shell.ownerDocument.activeElement || shell.ownerDocument.activeElement === shell.ownerDocument.body)) {
      focused.focus({ preventScroll: true });
    }
  };
};
