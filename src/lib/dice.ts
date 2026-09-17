// ── D&D d20 механика ──
export type CheckResult = {
  d20: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
  critical: "crit" | "fumble" | null;
  skill: string;
  label: string;
};

export const STAT_MODS: Record<string, string> = {
  СИЛ: "Атлетика, ближний бой",
  ЛОВ: "Скрытность, лук, акробатика",
  ВЫН: "Стойкость, выживание",
  ИНТ: "Магия, анализ, история",
  МУД: "Восприятие, медицина, воля",
  ХАР: "Убеждение, обман, запугивание",
};

export function statModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function rollD20(skill: string, modifier = 0, dc = 12): CheckResult {
  const d20 = 1 + Math.floor(Math.random() * 20);
  const total = d20 + modifier;
  const critical = d20 === 20 ? "crit" : d20 === 1 ? "fumble" : null;
  return {
    d20,
    modifier,
    total,
    dc,
    success: critical === "crit" ? true : critical === "fumble" ? false : total >= dc,
    critical,
    skill,
    label:
      critical === "crit"
        ? `КРИТ! d20=${d20} (${skill})`
        : critical === "fumble"
          ? `ПРОВАЛ! d20=${d20} (${skill})`
          : total >= dc
            ? `Успех ${total} vs DC ${dc} (${skill})`
            : `Неудача ${total} vs DC ${dc} (${skill})`,
  };
}

export function dcFor(danger: number, turnCount: number): number {
  // эскалация сложности: база 10 + накал + лёгкий рост по ходам
  return Math.min(20, 10 + Math.round(danger / 25) + Math.min(3, Math.floor(turnCount / 8)));
}
