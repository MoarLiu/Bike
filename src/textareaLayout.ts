// Measure outline textareas together so one row's height write cannot force
// layout again before the next row's scrollHeight read.
const widths = new Map<HTMLTextAreaElement, number | undefined>();
const pending = new Map<HTMLTextAreaElement, number>();
const delayed = new Map<HTMLTextAreaElement, number>();
let frame: number | null = null;
let timer: number | null = null;
let observer: ResizeObserver | null = null;
let fonts: FontFaceSet | null = null;
let fontGeneration = 0;

function scheduleFrame() {
  if (frame === null && pending.size) {
    frame = window.requestAnimationFrame(measurePending);
  }
}

function measurePending() {
  frame = null;
  const batch = [...pending].filter(([element]) => widths.has(element) && element.isConnected);
  pending.clear();

  for (const [element] of batch) element.style.height = "auto";
  const heights = batch.map(([element]) => element.scrollHeight);
  batch.forEach(([element], index) => {
    element.style.height = `${heights[index]}px`;
  });

  // Recheck on the following frame while the host settles its initial layout.
  for (const [element, passes] of batch) {
    if (passes > 1) pending.set(element, passes - 1);
  }
  scheduleFrame();
}

function scheduleTimer() {
  if (timer !== null || !delayed.size) return;
  let next = Infinity;
  for (const deadline of delayed.values()) next = Math.min(next, deadline);
  timer = window.setTimeout(measureDelayed, Math.max(0, next - window.performance.now()));
}

function measureDelayed() {
  timer = null;
  const now = window.performance.now();
  for (const [element, deadline] of delayed) {
    if (deadline > now) continue;
    delayed.delete(element);
    if (widths.has(element) && element.isConnected) pending.set(element, pending.get(element) ?? 1);
  }
  scheduleFrame();
  scheduleTimer();
}

export function requestTextareaResize(element: HTMLTextAreaElement | null) {
  if (!element || !widths.has(element)) return;
  pending.set(element, 2);
  delayed.set(element, window.performance.now() + 140);
  scheduleFrame();
  scheduleTimer();
}

function resizeAll() {
  for (const element of widths.keys()) requestTextareaResize(element);
}

export function observeTextareaLayout(element: HTMLTextAreaElement) {
  const first = widths.size === 0;
  widths.set(element, undefined);
  if (first) {
    observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLTextAreaElement;
        if (!widths.has(target) || widths.get(target) === entry.contentRect.width) continue;
        widths.set(target, entry.contentRect.width);
        requestTextareaResize(target);
      }
    });
    window.addEventListener("resize", resizeAll);
    fonts = element.ownerDocument.fonts ?? null;
    fonts?.addEventListener("loadingdone", resizeAll);
    const generation = ++fontGeneration;
    void fonts?.ready.then(() => {
      if (generation === fontGeneration) resizeAll();
    });
  }
  observer?.observe(element);
  requestTextareaResize(element);

  return () => {
    observer?.unobserve(element);
    widths.delete(element);
    pending.delete(element);
    delayed.delete(element);
    if (!pending.size && frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    if (!delayed.size && timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (!widths.size) {
      observer?.disconnect();
      observer = null;
      window.removeEventListener("resize", resizeAll);
      fonts?.removeEventListener("loadingdone", resizeAll);
      fonts = null;
      fontGeneration++;
    }
  };
}
