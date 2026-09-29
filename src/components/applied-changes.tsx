import { ArrowUp, Check, CircleX, Coins, EyeOff, Flag, FlaskConical, Flame, Heart, Link2, MapPin, Minus, Package, Plus, Shield, ShieldOff, Sparkles, Tag, Tags, TriangleAlert, UserRound } from "lucide-react";
import type { AppliedChanges } from "@/db/schema";
import { describeAppliedChanges, describeConsequences, type ChangeIcon } from "@/lib/applied-changes";

const icons = {
  plus: Plus, consume: FlaskConical, minus: Minus, equip: Shield, unequip: ShieldOff,
  health: Heart, xp: Sparkles, gold: Coins, danger: Flame, level: ArrowUp, warning: TriangleAlert,
  location: MapPin, quest: Flag, check: Check, failed: CircleX, hidden: EyeOff,
  "condition-add": Tags, "condition-remove": Tag, person: UserRound, object: Package,
} satisfies Record<ChangeIcon, typeof Plus>;

export function AppliedChips({ applied, turnNumber }: { applied: AppliedChanges; turnNumber?: number }) {
  const changes = describeAppliedChanges(applied);
  const consequences = describeConsequences(applied);
  return <>
    {!!changes.length && <ul className="gx-applied" aria-label="Последствия хода">{changes.slice(0, 5).map((change, i) => {
      const Icon = icons[change.icon];
      return <li key={i} className={`gx-applied-chip is-${change.tone}`}><Icon size={13} aria-hidden="true" />{change.label}</li>;
    })}</ul>}
    {!!changes.length && <details className="gx-change-details"><summary>Что изменилось в мире · {changes.length}</summary><div><p>Итоги{turnNumber !== undefined ? ` хода ${turnNumber}` : " действия"}: изменения предметов, ресурсов и событий.</p><ul>{changes.map((change, index) => { const Icon = icons[change.icon]; return <li key={index}><Icon size={14} aria-hidden="true" /><span>{change.label}</span></li>; })}</ul>
      {!!consequences.length && <dl className="gx-consequences">{consequences.map((row, i) => <div key={i}><dt>{row.group} · {row.subject}</dt><dd>{row.before !== null && <>{row.before} → </>}<strong>{row.after}</strong>{row.reason && <small> — {row.reason}</small>}</dd></div>)}</dl>}
      {turnNumber !== undefined && <a href={`#turn-${turnNumber}`}><Link2 size={12} />Источник: ход {turnNumber}</a>}
    </div></details>}
    {!!applied.rejected.length && <details className="gx-rejected"><summary>Не удалось применить изменения · {applied.rejected.length}</summary>{applied.rejected.map((reason, i) => <p key={i}>{reason}</p>)}</details>}
  </>;
}
