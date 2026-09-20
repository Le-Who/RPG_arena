"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function Dialog({ children, onClose, title, wide = false, className = "", suspended = false }: { children: ReactNode; onClose: () => void; title: string; wide?: boolean; className?: string; suspended?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (suspended) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []).filter(node => node.getClientRects().length > 0 && !node.closest("[inert]"));
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const keepFocus = (event: FocusEvent) => { if (event.target instanceof Node && !ref.current?.contains(event.target)) ref.current?.focus({ preventScroll: true }); };
    document.addEventListener("keydown", key);
    document.addEventListener("focusin", keepFocus);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", key); document.removeEventListener("focusin", keepFocus); previous?.focus({ preventScroll: true }); };
  }, [suspended]);
  return <div className="dialog-backdrop" hidden={suspended} inert={suspended} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className={`dialog ${wide ? "dialog-wide" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}><button className="icon-button dialog-close" onClick={onClose} aria-label="Закрыть"><X size={19} /></button>{children}</div></div>;
}
