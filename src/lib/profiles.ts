// ── Профили механик (MECH-1) ─────────────────────────────────
// Каждая кампания хранит rulesProfile. D&D/d20 — один из профилей, а не глобальное допущение.
// Профиль определяет: какие ресурсы существуют, какие проверки делает сервер,
// какие эффекты и в каких пределах допустимы, какие панели показывает UI,
// и какой текст канона получают narration/resolution/extraction промпты (MECH-1b).

import type { RulesProfile, CampaignMode } from "@/db/schema";

export type ProfileSpec = {
  id: RulesProfile;
  label: string;
  short: string;
  description: string;
  /** Какие числовые ресурсы реально существуют в профиле. */
  resources: { hp: boolean; xp: boolean; gold: boolean; stats: boolean; conditions: boolean };
  /** Какой тип проверки делает сервер для свободного действия. */
  check: "d20" | "2d6" | "none";
  /** Пределы изменений за один ход — сервер клампит любые числа модели (RES-1d). */
  limits: { hp: number; xp: number; gold: number; danger: number; relation: number };
  /** Названия ресурсов для UI/промптов (жанронейтральные). */
  labels: { hp: string; xp: string; gold: string };
  /** Текст канона механик для промптов — модель не может менять профиль (MECH-1c). */
  promptCanon: string;
  uiPanels: { stats: boolean; hpBar: boolean; xpLevel: boolean; gold: boolean; conditions: boolean; dice: boolean };
};

export const PROFILE_SPECS: Record<RulesProfile, ProfileSpec> = {
  d20: {
    id: "d20",
    label: "d20 — статы и броски",
    short: "d20",
    description:
      "Шесть характеристик, серверный бросок d20 против сложности (DC), HP, опыт и уровни. Подходит для героики, данжен-кроула и любых историй, где нужен формальный риск.",
    resources: { hp: true, xp: true, gold: true, stats: true, conditions: true },
    check: "d20",
    limits: { hp: 20, xp: 60, gold: 120, danger: 12, relation: 30 },
    labels: { hp: "HP", xp: "Опыт", gold: "Золото / средства" },
    promptCanon:
      "Механика: профиль d20. Исход рискованного действия определяет СЕРВЕРНЫЙ бросок d20 + модификатор против DC — он передаётся тебе как факт и не подлежит изменению. HP, опыт и средства — числовые ресурсы; их изменения ограничены сервером. Не выдумывай собственные броски и не меняй правила.",
    uiPanels: { stats: true, hpBar: true, xpLevel: true, gold: true, conditions: true, dice: true },
  },
  "rules-light": {
    id: "rules-light",
    label: "Rules-light — риск без таблиц",
    short: "2d6",
    description:
      "Без характеристик и уровней. Сервер оценивает риск действия и делает скрытую 2d6-проверку: полный успех, успех с ценой или провал. Здоровье и состояния есть, опыта и золота как счётчиков нет.",
    resources: { hp: true, xp: false, gold: true, stats: false, conditions: true },
    check: "2d6",
    limits: { hp: 15, xp: 0, gold: 80, danger: 12, relation: 30 },
    labels: { hp: "Состояние", xp: "—", gold: "Средства" },
    promptCanon:
      "Механика: профиль rules-light. Нет характеристик, уровней и опыта. Для рискованного действия сервер делает 2d6-проверку с исходом «полный успех» / «успех с ценой» / «провал» — исход передаётся как факт. Последствия выражай через состояние героя (ранен, измотан, разоблачён…), отношения, ресурсы сцены и квесты. Не используй термины D&D.",
    uiPanels: { stats: false, hpBar: true, xpLevel: false, gold: true, conditions: true, dice: true },
  },
  narrative: {
    id: "narrative",
    label: "Narrative — только история",
    short: "story",
    description:
      "Никаких бросков, HP, опыта и золота. Последствия следуют из канона, намерения игрока, сцены и границ истории. Состояния героя и отношения с персонажами — единственные «ресурсы».",
    resources: { hp: false, xp: false, gold: false, stats: false, conditions: true },
    check: "none",
    limits: { hp: 0, xp: 0, gold: 0, danger: 12, relation: 30 },
    labels: { hp: "—", xp: "—", gold: "—" },
    promptCanon:
      "Механика: профиль narrative. Нет бросков, HP, опыта, золота и характеристик — не упоминай их и не вводи. Исход действия выводи из канона, правдоподобия, намерения игрока и уже установленных фактов; действия могут проваливаться и иметь цену. Последствия фиксируй через состояния героя, отношения NPC, объекты сцены, локации и квесты.",
    uiPanels: { stats: false, hpBar: false, xpLevel: false, gold: false, conditions: true, dice: false },
  },
};

export const RULES_PROFILE_IDS: RulesProfile[] = ["d20", "rules-light", "narrative"];

export function isRulesProfile(v: unknown): v is RulesProfile {
  return typeof v === "string" && (RULES_PROFILE_IDS as string[]).includes(v);
}

export function isCampaignMode(v: unknown): v is CampaignMode {
  return v === "preset" || v === "free";
}

export function profileFor(id: string | null | undefined): ProfileSpec {
  return PROFILE_SPECS[(isRulesProfile(id) ? id : "d20") as RulesProfile];
}

/** Оценка риска для rules-light: «safe» → проверка не нужна, иначе 2d6. */
export function assessRisk(action: string, danger: number): "safe" | "risky" | "desperate" {
  const a = action.toLowerCase();
  const violent = /атак|удар|бой|драк|стрел|напад|взлом|проник|пробир|тайк|тайно|незамет|крад|украд|бег|прыг|погон|угрож|ложь|солг|обман|взорв|поджеч|сбеж|лаз|ныря|взбир|карабк|рискн|бросаюсь|хвата/.test(a);
  const social = /убед|уговор|переговор|торг|подкуп|флирт|соблазн|допрос|обвин/.test(a);
  if (!violent && !social) return danger >= 70 ? "risky" : "safe";
  if (violent && danger >= 60) return "desperate";
  return "risky";
}
