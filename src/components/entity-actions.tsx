"use client";
import { useEffect, useRef, useState } from "react";
import { Hand, MoreHorizontal } from "lucide-react";
import { availableActions, interactionText, npcPresent, type EntityKind, type Interaction, type InteractionState } from "@/lib/interactions";

/** INTERACT-1: контекстные действия. Кнопка формирует каноническую фразу, которую сервер разбирает тем же контрактом. */
export function EntityActions({ kind, refId, name, state, disabled, onPick }: {
  kind: EntityKind; refId: string; name: string; state: InteractionState; disabled?: boolean;
  onPick: (text: string, itemIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [giving, setGiving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) { setOpen(false); setGiving(false); }
    };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  const actions = availableActions(kind, refId, state);
  const targetKind = kind === "holding" ? "holding" : kind;
  const pick = (interaction: Interaction) => {
    onPick(interactionText(interaction), kind === "item" ? [refId] : []);
    setOpen(false); setGiving(false);
  };
  const present = state.npcs.filter((npc) => npcPresent(state, npc));
  return <div className="lx-actions" ref={root}>
    <button type="button" className="lx-actions-toggle" aria-haspopup="menu" aria-expanded={open} aria-label={`Действия: ${name}`} disabled={disabled} onClick={() => setOpen((v) => !v)}>
      <Hand size={13} aria-hidden="true" /><span>Действия</span><MoreHorizontal size={13} aria-hidden="true" />
    </button>
    {open && <div className="lx-menu" role="menu" aria-label={`Что сделать: ${name}`}>
      {!giving && actions.map((action) => <button key={action.verb} role="menuitem" type="button" disabled={!action.enabled} title={action.reason}
        onClick={() => action.verb === "give" ? setGiving(true) : pick({ verb: action.verb, target: { kind: targetKind, ref: refId, name } })}>
        <span>{action.label}</span>{!action.enabled && action.reason && <small>{action.reason}</small>}
      </button>)}
      {giving && <>
        <p className="lx-menu-hint">Кому передать «{name}»? Получатель может отказаться — вещь уйдёт только после согласия.</p>
        {present.map((npc) => <button key={npc.key} role="menuitem" type="button" onClick={() => pick({ verb: "give", target: { kind: "item", ref: refId, name }, recipient: { kind: "npc", ref: npc.key, name: npc.name } })}><span>{npc.name}</span></button>)}
        <button type="button" role="menuitem" className="lx-menu-back" onClick={() => setGiving(false)}><span>Назад</span></button>
      </>}
    </div>}
  </div>;
}
