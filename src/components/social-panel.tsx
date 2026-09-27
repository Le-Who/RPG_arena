"use client";
import { CalendarClock, Link2, MapPin } from "lucide-react";
import type { WorldState } from "@/db/schema";
import { BOND_KIND_LABELS, formatWindow, npcPresence, readSocial } from "@/lib/world-social";

type NpcLite = { key: string; name: string; status: string };

/** WORLD-2b (2.9): кто сейчас рядом по распорядку — детерминированный расчёт от часов мира, без вызова модели. */
export function PresenceStrip({ world, npcs }: { world: WorldState; npcs: NpcLite[] }) {
  const presence = npcPresence(world, npcs);
  if (!presence.here.length && !presence.away.length && !presence.later.length) return null;
  return <section className="sx-presence" aria-label="Люди по распорядку">
    <div className="gx-side-title"><CalendarClock size={13} />Люди по распорядку</div>
    {presence.here.length > 0 && <p className="sx-here"><MapPin size={12} aria-hidden="true" /> Здесь сейчас: {presence.here.map((e) => `${e.name} (${e.hint})`).join(", ")}</p>}
    {presence.away.length > 0 && <p className="sx-away">В других местах: {presence.away.map((e) => `${e.name} — «${e.place}», ${e.hint}`).join("; ")}</p>}
    {presence.later.length > 0 && <p className="sx-later">Позже: {presence.later.slice(0, 5).map((e) => `${e.name} — «${e.place}», ${e.hint}`).join("; ")}</p>}
    <small className="sx-note">Считается по часам мира и распорядку, раскрытому в сценах. Рассказ может показать причину отклонения.</small>
  </section>;
}

/** WORLD-2 (2.9): история связи, знания и распорядок NPC; ссылки ведут к исходному ходу. */
export function NpcBondDetails({ world, npcKey }: { world: WorldState; npcKey: string }) {
  const social = readSocial(world);
  const bond = social.bonds.find((b) => b.key === npcKey);
  const slots = social.schedules.filter((s) => s.npcKey === npcKey);
  if (!bond?.history.length && !bond?.knows.length && !slots.length) return null;
  return <details className="sx-bond">
    <summary>Связь и распорядок</summary>
    {slots.length > 0 && <ul className="sx-slots">{slots.map((s) => <li key={s.id}><CalendarClock size={11} aria-hidden="true" /> «{s.place}», {formatWindow(s)}{s.note ? ` — ${s.note}` : ""}</li>)}</ul>}
    {!!bond?.knows.length && <><small className="sx-label">Знает</small><ul className="sx-knows">{bond.knows.map((k, i) => <li key={`${k.turn}-${i}`}>{k.text} <a href={`#turn-${k.turn}`}>ход {k.turn}</a></li>)}</ul></>}
    {!!bond?.history.length && <><small className="sx-label">Что было между вами</small><ol className="sx-history">{[...bond.history].reverse().map((h, i) => <li key={`${h.turn}-${i}`} className={h.delta > 0 ? "is-pos" : h.delta < 0 ? "is-neg" : ""}>
      <span className="sx-kind">{BOND_KIND_LABELS[h.kind]}</span> {h.text}{h.delta ? <strong> {h.delta > 0 ? "+" : "−"}{Math.abs(h.delta)}</strong> : null}{" "}
      <a href={`#turn-${h.turn}`} aria-label={`Перейти к ходу ${h.turn}`}><Link2 size={10} aria-hidden="true" />ход {h.turn}</a>
    </li>)}</ol></>}
  </details>;
}
