import { useRef, useState, type MutableRefObject, type TextareaHTMLAttributes } from "react";
import { activeLinkQuery, insertLinkAtQuery, type Suggestion } from "../knowledge";
import { LinkAutocomplete } from "./LinkAutocomplete";

type Choices = { items: Suggestion[]; requiresExplicit: boolean; highlight: number; query: { start: number; end: number } };
export function LinkInput({ onSuggest, onBind, onCreate, inputRef, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>;
  value: string;
  onSuggest: (query: string) => Omit<Choices, "query">;
  onBind: (text: string, span: { start: number; end: number; raw: string }, target: { documentId: string; nodeId?: string }, mode: "auto" | "custom") => void;
  onCreate: (text: string, query: { start: number; end: number }, title: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [popup, setPopup] = useState<{ top?: number; bottom?: number; maxHeight: number }>({ top: 32, maxHeight: 260 });
  const dismissed = useRef<string | null>(null);
  const refresh = (text: string, caret: number) => {
    const query = activeLinkQuery(text, caret);
    if (!query || dismissed.current === `${query.start}:${query.end}:${query.query}`) { setChoices(null); return; }
    if (ref.current) {
      const input = ref.current;
      const rect = input.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 22;
      const top = Math.max(28, Math.min(input.clientHeight, text.slice(0, caret).split("\n").length * lineHeight - input.scrollTop + 12));
      const below = window.innerHeight - rect.top - top - 20;
      setPopup(below < 160 ? { bottom: Math.max(0, input.clientHeight - top + 24), maxHeight: Math.max(100, Math.min(260, rect.top + top - 32)) } : { top, maxHeight: Math.min(280, below) });
    }
    setChoices({ ...onSuggest(query.query ?? ""), query });
  };
  const choose = (item: Suggestion) => {
    if (!choices) return;
    const text = ref.current?.value ?? props.value;
    if (item.kind === "create") onCreate(text, choices.query, item.title);
    else {
      const inserted = insertLinkAtQuery(text, choices.query, { documentName: item.documentTitle || item.title, nodeName: item.kind === "node" ? item.title : null });
      onBind(inserted.text, inserted, { documentId: item.documentId!, ...(item.nodeId ? { nodeId: item.nodeId } : {}) }, inserted.labelMode);
    }
    setChoices(null);
    const inserted = insertLinkAtQuery(text, choices.query, { documentName: item.documentTitle || item.title, nodeName: item.kind === "node" ? item.title : null });
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(inserted.end, inserted.end); });
  };
  return <div className="wiki-input-wrap">
    <textarea {...props} ref={(element) => { ref.current = element; if (inputRef) inputRef.current = element; }}
      onChange={(event) => { dismissed.current = null; props.onChange?.(event); refresh(event.target.value, event.target.selectionStart); }}
      onClick={(event) => { props.onClick?.(event); refresh(event.currentTarget.value, event.currentTarget.selectionStart); }}
      onKeyDown={(event) => {
        if (!event.nativeEvent.isComposing && choices?.items.length) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); event.stopPropagation();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setChoices({ ...choices, highlight: choices.highlight < 0 ? (delta > 0 ? 0 : choices.items.length - 1) : (choices.highlight + delta + choices.items.length) % choices.items.length });
            return;
          }
          if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (choices.highlight >= 0) choose(choices.items[choices.highlight]); return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissed.current = `${choices.query.start}:${choices.query.end}:${props.value.slice(choices.query.start + 2, choices.query.end)}`; setChoices(null); return; }
        }
        if (!event.nativeEvent.isComposing) props.onKeyDown?.(event);
      }}
      onBlur={(event) => { props.onBlur?.(event); setChoices(null); }}
    />
    {choices && <div className="link-input-popup" style={popup}><LinkAutocomplete {...choices} onHighlight={(highlight) => setChoices({ ...choices, highlight })} onSelect={choose} onCancel={() => setChoices(null)} /></div>}
  </div>;
}
