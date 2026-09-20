import { ArrowUp, Check, CircleX, Coins, EyeOff, Flag, FlaskConical, Flame, Heart, MapPin, Minus, Package, Plus, Shield, ShieldOff, Sparkles, Tag, Tags, TriangleAlert, UserRound } from "lucide-react";
import type { AppliedChanges } from "@/db/schema";
import { describeAppliedChanges, type ChangeIcon } from "@/lib/applied-changes";

const icons = {
  plus: Plus, consume: FlaskConical, minus: Minus, equip: Shield, unequip: ShieldOff,
  health: Heart, xp: Sparkles, gold: Coins, danger: Flame, level: ArrowUp, warning: TriangleAlert,
  location: MapPin, quest: Flag, check: Check, failed: CircleX, hidden: EyeOff,
  "condition-add": Tags, "condition-remove": Tag, person: UserRound, object: Package,
} satisfies Record<ChangeIcon, typeof Plus>;

export function AppliedChips({ applied }: { applied: AppliedChanges }) {
  const changes = describeAppliedChanges(applied);
  return <>
    {!!changes.length && <ul className="gx-applied" aria-label="Последствия хода">{changes.map((change, i) => {
      const Icon = icons[change.icon];
      return <li key={i} className={`gx-applied-chip is-${change.tone}`}><Icon size={13} aria-hidden="true" />{change.label}</li>;
    })}</ul>}
    {!!applied.rejected.length && <details className="gx-rejected"><summary>Сервер не применил {applied.rejected.length} изменений</summary>{applied.rejected.map((reason, i) => <p key={i}>{reason}</p>)}</details>}
  </>;
}
