import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Download } from 'lucide-react';

type DocumentFormat = 'markdown' | 'opml' | 'freemind' | 'html';
export function ExportMenu({ onDocument, onPdf, onWorkspace }: {
  onDocument: (format: DocumentFormat, metadata?: boolean) => void;
  onPdf: () => void;
  onWorkspace: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = [
    { label: '导出 MD', action: () => onDocument('markdown') },
    { label: '带元数据', action: () => onDocument('markdown', true) },
    { label: 'OPML', action: () => onDocument('opml') },
    { label: 'FreeMind', action: () => onDocument('freemind') },
    { label: 'HTML', action: () => onDocument('html') },
    { label: 'PDF', action: onPdf },
    { label: '工作区', action: onWorkspace },
  ];
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = 200, height = menu.current?.offsetHeight ?? 290;
      setPosition({ left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)),
        top: anchor.bottom + height + 8 < window.innerHeight ? anchor.bottom + 6 : Math.max(12, anchor.top - height - 6) });
    };
    update();
    const first = menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]');
    first?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) close();
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) update(); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', update); window.removeEventListener('scroll', scroll, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [open]);
  return <>
    <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'document-export-menu' : undefined}
      className={open ? 'export-trigger selected' : 'export-trigger'} onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
      <Download size={16} />导出<ChevronDown size={14} />
    </button>
    {open && createPortal(<div ref={menu} id="document-export-menu" className="export-menu" role="menu" aria-label="导出文档" style={position}
      onKeyDown={(event) => {
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        } else if (event.key === 'Tab') close();
      }}>
      {items.map((item) => <button key={item.label} type="button" role="menuitem" className="export-menu-item" onClick={() => { close(true); item.action(); }}>{item.label}</button>)}
    </div>, document.body)}
  </>;
}
