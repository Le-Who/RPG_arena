// ── MECH-4: механически определённые состояния героя ──
// До 2.8 состояния («ранен», «устал», «под подозрением») были свободным текстом: их трактовала модель,
// поэтому одно и то же состояние в разных ходах влияло на исход по-разному. Здесь задан серверный
// каталог: какой модификатор даёт состояние, к каким проверкам применяется и когда снимается
// автоматически по времени мира. Неизвестные состояния остаются чисто описательными (модификатор 0).
import type { CharacterState, WorldState } from "@/db/schema";
import type { MemoryEvent } from "./resolution";
import { advanceClock, clockValue, formatClock, normName, type WorldClock } from "./world-life";

export type ConditionScope = "physical" | "social" | "mental" | "all";
export type ConditionRule = {
  /** Человекочитаемое имя группы (для UI и промпта). */
  label: string;
  /** Модификатор к броску: отрицательный мешает, положительный помогает. */
  modifier: number;
  scope: ConditionScope;
  /** Через сколько минут мира состояние снимается само; null — только событием сцены. */
  durationMinutes: number | null;
  /** Краткое объяснение для модели и панели. */
  note: string;
};

const RULES: { pattern: RegExp; rule: ConditionRule }[] = [
  { pattern: /тяжело ранен|тяжёлое ранение|при смерти|на грани/, rule: { label: "Тяжёлое ранение", modifier: -4, scope: "all", durationMinutes: null, note: "Любое усилие даётся с трудом; снимается только лечением или долгим отдыхом." } },
  { pattern: /ранен|ранение|кровотеч|перелом|ушиб/, rule: { label: "Ранение", modifier: -2, scope: "physical", durationMinutes: null, note: "Физические действия затруднены до лечения." } },
  { pattern: /отравлен|отравление|тошнит/, rule: { label: "Отравление", modifier: -2, scope: "physical", durationMinutes: null, note: "Снимается лечением или событием сцены." } },
  { pattern: /болен|болеет|простуж|лихорадк|(?:^|\s)жар(?:$|\s)/, rule: { label: "Болезнь", modifier: -1, scope: "all", durationMinutes: null, note: "Снимается выздоровлением в сцене." } },
  { pattern: /устал|усталост|измотан|изнур|не выспал|сонлив/, rule: { label: "Усталость", modifier: -1, scope: "all", durationMinutes: null, note: "Снимается отдыхом в сцене." } },
  { pattern: /пьян|опьянен|нетрезв|под хмельком/, rule: { label: "Опьянение", modifier: -2, scope: "mental", durationMinutes: 4 * 60, note: "Мышление и точность страдают несколько часов." } },
  { pattern: /испуг|напуган|в страхе|паник|в ужасе/, rule: { label: "Страх", modifier: -2, scope: "mental", durationMinutes: 2 * 60, note: "Мешает сосредоточиться и говорить уверенно." } },
  { pattern: /в ярости|разъярен|разгневан|в гневе/, rule: { label: "Ярость", modifier: -2, scope: "social", durationMinutes: 60, note: "Разговоры и переговоры идут хуже, пока не остынешь." } },
  { pattern: /под подозрением|подозревают|разыскива|в розыске/, rule: { label: "Под подозрением", modifier: -2, scope: "social", durationMinutes: null, note: "Люди насторожены; снимается только событием истории." } },
  { pattern: /промок|мокр|замёрз|замерз|продрог/, rule: { label: "Продрог", modifier: -1, scope: "physical", durationMinutes: 2 * 60, note: "Проходит в тепле." } },
  { pattern: /голод|не ел|не ела/, rule: { label: "Голод", modifier: -1, scope: "all", durationMinutes: null, note: "Снимается едой или событием сцены." } },
  { pattern: /вдохновл|воодушевл|окрылён|окрылен|на подъёме|на подъеме/, rule: { label: "Вдохновение", modifier: 2, scope: "all", durationMinutes: 3 * 60, note: "Короткий подъём сил и уверенности." } },
  { pattern: /отдохнул|выспал|бодр|свеж/, rule: { label: "Отдых", modifier: 1, scope: "all", durationMinutes: 4 * 60, note: "Небольшое преимущество после хорошего отдыха." } },
  { pattern: /сосредоточ|собран/, rule: { label: "Сосредоточенность", modifier: 1, scope: "mental", durationMinutes: 2 * 60, note: "Помогает в точной и умственной работе." } },
];

const SKILL_SCOPE: Record<string, ConditionScope> = {
  "Атлетика": "physical", "Акробатика": "physical", "Скрытность": "physical", "Выживание": "physical", "Бой": "physical", "Ближний бой": "physical", "Стрельба": "physical",
  "Убеждение": "social", "Обман": "social", "Запугивание": "social", "Выступление": "social",
  "Восприятие": "mental", "Анализ": "mental", "Магия": "mental", "Взлом": "mental", "Медицина": "mental", "Ремесло": "mental",
};

export const MIN_CONDITION_MODIFIER = -5;
export const MAX_CONDITION_MODIFIER = 3;

/** Правило из каталога для строки состояния; null — состояние только описательное. */
export function conditionRule(condition: string): ConditionRule | null {
  const text = normName(condition);
  if (!text) return null;
  if (/^не (?:ранен|ранена|болен|больна|отравлен|отравлена|устал|устала|голоден|голодна|испуган|испугана)(?:$|\s)/.test(text)
    || /(?: нет| отсутствует)$/.test(text)) return null;
  for (const entry of RULES) if (entry.pattern.test(text)) return entry.rule;
  return null;
}

export type ConditionEffect = { condition: string; rule: ConditionRule };

export function conditionEffects(conditions: readonly string[] | undefined): ConditionEffect[] {
  const out: ConditionEffect[] = [];
  for (const condition of conditions ?? []) {
    const rule = conditionRule(condition);
    if (rule) out.push({ condition, rule });
  }
  return out;
}

function scopeApplies(scope: ConditionScope, skill: string | undefined): boolean {
  if (scope === "all") return true;
  if (!skill) return true; // 2d6-риск и общие проверки: действует всё
  const target = SKILL_SCOPE[skill];
  return target === undefined ? true : target === scope;
}

/** Суммарный модификатор состояний к проверке навыка (ограничен, чтобы одно состояние не блокировало игру). */
export function conditionModifier(conditions: readonly string[] | undefined, skill?: string): number {
  let sum = 0;
  for (const effect of conditionEffects(conditions)) if (scopeApplies(effect.rule.scope, skill)) sum += effect.rule.modifier;
  return Math.max(MIN_CONDITION_MODIFIER, Math.min(MAX_CONDITION_MODIFIER, sum));
}

/** Короткое описание действующих состояний для промпта и подсказок UI. */
export function describeConditionEffects(conditions: readonly string[] | undefined): string {
  const effects = conditionEffects(conditions);
  if (!effects.length) return "";
  return effects.map((e) => `«${e.condition}»: ${e.rule.modifier > 0 ? "+" : ""}${e.rule.modifier} (${e.rule.scope === "all" ? "все проверки" : e.rule.scope === "physical" ? "физические" : e.rule.scope === "social" ? "социальные" : "умственные"})`).join("; ");
}

// ─────────────────────────────────────────────────────────────
//  Таймеры: состояния с длительностью снимаются по времени мира
// ─────────────────────────────────────────────────────────────
export type ConditionTimer = { expiresAt: WorldClock; sinceTurn: number };
export type ConditionTimers = Record<string, ConditionTimer>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function readConditionTimers(world: WorldState): ConditionTimers {
  const raw = (world as WorldState & { conditionTimers?: unknown }).conditionTimers;
  if (!isRecord(raw)) return {};
  const out: ConditionTimers = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || !isRecord(value.expiresAt)) continue;
    const day = Number(value.expiresAt.day), minute = Number(value.expiresAt.minute);
    if (!Number.isFinite(day) || !Number.isFinite(minute)) continue;
    out[key] = { expiresAt: { day: Math.max(1, Math.floor(day)), minute: Math.max(0, Math.min(24 * 60 - 1, Math.floor(minute))) }, sinceTurn: Number(value.sinceTurn) || 0 };
  }
  return out;
}

export type ConditionTimerResult = {
  world: WorldState;
  character: CharacterState;
  expired: string[];
  /** Состояния, получившие таймер в этом ходе (для UI «пройдёт к …»). */
  scheduled: { condition: string; expiresAt: WorldClock }[];
  events: MemoryEvent[];
};

/**
 * Регистрирует таймеры для новых состояний и снимает истёкшие по часам мира.
 * Вызывается после applyLife (часы уже сдвинуты). Состояния без длительности не трогаются.
 */
export function applyConditionTimers(input: { world: WorldState; character: CharacterState; clock: WorldClock; added: readonly string[]; turnNumber: number; heroName?: string }): ConditionTimerResult {
  const timers = { ...readConditionTimers(input.world) };
  const conditions = [...(input.character.conditions ?? [])];
  const scheduled: ConditionTimerResult["scheduled"] = [];
  const events: MemoryEvent[] = [];
  // Новые состояния с длительностью получают срок окончания.
  for (const condition of input.added) {
    const rule = conditionRule(condition);
    if (!rule || rule.durationMinutes === null) continue;
    const key = normName(condition);
    timers[key] = { expiresAt: advanceClock(input.clock, rule.durationMinutes), sinceTurn: input.turnNumber };
    scheduled.push({ condition, expiresAt: timers[key].expiresAt });
  }
  // Истёкшие — снимаем; таймеры без состояния (снято сценой) — чистим.
  const now = clockValue(input.clock);
  const expired: string[] = [];
  for (const [key, timer] of Object.entries(timers)) {
    const index = conditions.findIndex((c) => normName(c) === key);
    if (index < 0) { delete timers[key]; continue; }
    if (clockValue(timer.expiresAt) <= now && !input.added.some((c) => normName(c) === key)) {
      expired.push(conditions[index]);
      conditions.splice(index, 1);
      delete timers[key];
    }
  }
  if (expired.length) {
    const hero = input.heroName ?? input.character.name;
    events.push({
      layer: "episodic", category: "character", title: `Состояния прошли: ${expired.join(", ")}`,
      content: `К ${formatClock(input.clock)} у ${hero} прошло: ${expired.join(", ")} (ход ${input.turnNumber}).`,
      importance: 30, entityKey: `character:conditions:expired:${input.turnNumber}`, mode: "upsert",
    });
    events.push({
      layer: "semantic", category: "character", title: "Состояние героя",
      content: conditions.length ? `Текущие состояния ${hero}: ${conditions.join(", ")} (обновлено на ходу ${input.turnNumber}).` : `У ${hero} нет активных состояний (ход ${input.turnNumber}).`,
      importance: 64, entityKey: "character:conditions", mode: "upsert",
    });
  }
  const world = { ...input.world, conditionTimers: timers } as WorldState;
  return { world, character: { ...input.character, conditions }, expired, scheduled, events };
}

/** Для панели героя: когда состояние пройдёт само. */
export function conditionExpiry(world: WorldState, condition: string): WorldClock | null {
  return readConditionTimers(world)[normName(condition)]?.expiresAt ?? null;
}
