import { useLayoutEffect, useRef } from "react";
import type { HTMLAttributes } from "react";

const stack: HTMLDivElement[] = [];
const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(
  'button:not(:disabled),input:not(:disabled):not([type="hidden"]),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])',
)).filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");

export function Modal({ onDismiss, children, ...attributes }: HTMLAttributes<HTMLDivElement> & { onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    const root = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(root);
    const active = () => stack[stack.length - 1] === root;
    const focusFirst = () => (focusables(root)[0] ?? root).focus();
    const key = (event: KeyboardEvent) => {
      if (!active() || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); dismiss.current();
      } else if (event.key === "Tab") {
        const items = focusables(root), first = items[0], last = items[items.length - 1];
        if (!first) { event.preventDefault(); root.focus(); return; }
        if (!root.contains(document.activeElement) || document.activeElement === root ||
            (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last! : first).focus();
        }
      }
    };
    const keepFocus = (event: FocusEvent) => {
      if (active() && event.target instanceof Node && !root.contains(event.target)) focusFirst();
    };
    focusFirst();
    document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", keepFocus);
    return () => {
      const wasActive = active();
      const index = stack.indexOf(root);
      if (index >= 0) stack.splice(index, 1);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", keepFocus);
      if (wasActive && previous?.isConnected) previous.focus();
    };
  }, []);
  return <div {...attributes} ref={ref} tabIndex={-1}>{children}</div>;
}
