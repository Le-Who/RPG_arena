// ── Серверные проверки: d20 (профиль d20) и 2d6 (профиль rules-light) ──
import type { DiceResult } from "@/db/schema";

export type CheckResult = DiceResult;

export const STAT_MODS: Record<string, string> = {
  СИЛ: "Атлетика, ближний бой",
  ЛОВ: "Скрытность, стрельба, акробатика",
  ВЫН: "Стойкость, выживание",
  ИНТ: "Анализ, знания, техника",
  МУД: "Восприятие, медицина, воля",
  ХАР: "Убеждение, обман, запугивание",
};

export function statModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Инъекция генератора — для детерминированных тестов. */
export type Rng = () => number;
const defaultRng: Rng = () => Math.random();

export function rollD20(skill: string, modifier = 0, dc = 12, rng: Rng = defaultRng): CheckResult {
  const d20 = 1 + Math.floor(rng() * 20);
  const total = d20 + modifier;
  const critical = d20 === 20 ? "crit" : d20 === 1 ? "fumble" : null;
  const success = critical === "crit" ? true : critical === "fumble" ? false : total >= dc;
  return {
    kind: "d20",
    d20,
    modifier,
    total,
    dc,
    success,
    critical,
    skill,
    band: critical === "crit" ? "full" : success ? (total >= dc + 5 ? "full" : "cost") : "fail",
    label:
      critical === "crit"
        ? `КРИТ! d20=${d20} (${skill})`
        : critical === "fumble"
          ? `ПРОВАЛ! d20=${d20} (${skill})`
          : success
            ? `Успех ${total} vs DC ${dc} (${skill})`
            : `Неудача ${total} vs DC ${dc} (${skill})`,
  };
}

/**
 * 2d6 риск-проверка для rules-light: 10+ полный успех, 7–9 успех с ценой, 6- провал.
 * Модификатор: −1 при отчаянном риске, +1 при благоприятных условиях (задаёт вызывающий).
 */
export function roll2d6(label: string, modifier = 0, rng: Rng = defaultRng): CheckResult {
  const a = 1 + Math.floor(rng() * 6);
  const b = 1 + Math.floor(rng() * 6);
  const total = a + b + modifier;
  const band: "full" | "cost" | "fail" = total >= 10 ? "full" : total >= 7 ? "cost" : "fail";
  return {
    kind: "2d6",
    d20: a * 10 + b, // компактно храним обе кости (например 3 и 5 → 35)
    modifier,
    total,
    dc: 7,
    success: band !== "fail",
    critical: a === 6 && b === 6 ? "crit" : a === 1 && b === 1 ? "fumble" : null,
    skill: label,
    band,
    label:
      band === "full"
        ? `Полный успех ${a}+${b}${modifier ? (modifier > 0 ? `+${modifier}` : modifier) : ""} (${label})`
        : band === "cost"
          ? `Успех с ценой ${a}+${b}${modifier ? (modifier > 0 ? `+${modifier}` : modifier) : ""} (${label})`
          : `Провал ${a}+${b}${modifier ? (modifier > 0 ? `+${modifier}` : modifier) : ""} (${label})`,
  };
}

export function dcFor(danger: number, turnCount: number): number {
  // эскалация сложности: база 10 + накал + лёгкий рост по ходам
  return Math.min(20, 10 + Math.round(danger / 25) + Math.min(3, Math.floor(turnCount / 8)));
}
