"use client";
import { useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Dialog } from "./dialog";

/** Secondary explanations stay reachable by touch and keyboard. */
export function ContextualHelp({ title, children, label }: { title: string; children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="icon-button contextual-help" aria-label={label ?? `Справка: ${title}`} aria-haspopup="dialog" onClick={() => setOpen(true)}><CircleHelp size={18} aria-hidden="true" /></button>{open && <Dialog title={title} onClose={() => setOpen(false)}><div className="help-content">{children}</div></Dialog>}</>;
}
