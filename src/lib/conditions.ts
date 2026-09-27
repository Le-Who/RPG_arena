// ── MECH-4 / MECH-4b: механически определённые состояния героя ──
// До 2.8 состояния («ранен», «устал», «под подозрением») были свободным текстом: их трактовала модель,
// поэтому одно и то же состояние в разных ходах влияло на исход по-разному. Здесь задан серверный
// каталог: какой модификатор даёт состояние, к каким проверкам применяется, когда снимается
// автоматически по времени мира и (2.9, MECH-4b) каким ПРОВЕРЯЕМЫМ событием его можно снять.
// Неизвестные состояния остаются чисто описательными (модификатор 0, снятие без ограничений).
//
// Важно: сравнение идёт по normName (ё→е, без пунктуации), поэтому шаблоны пишутся через «е».
// JS \b не работает с кириллицей — границы слова задаются явно через (^|\s).
import type { CharacterState, WorldState } from "@/db/schema";
import type { MemoryEvent } from "./resolution";
import { advanceClock, clockValue, formatClock, normName, type IntentKind, type WorldClock } from "./world-life";

export type ConditionScope = "physical" | "social" | "mental" | "all";
/** Каким проверяемым событием хода состояние может быть снято (MECH-4b). */
export type CureTrigger = "time" | "scene" | "rest" | "sleep" | "medicine" | "treatment" | "food";
export type ConditionRule = {
  /** Человекочитаемое имя группы (для UI и промпта). */
  label: string;
  /** Модификатор к броску: отрицательный мешает, положительный помогает. */
  modifier: number;
  scope: ConditionScope;
  /** Через сколько минут мира состояние снимается само; null — только событием. */
  durationMinutes: number | null;
  /** Краткое объяснение для модели и панели. */
  note: string;
  /** Любое из событий снимает состояние; "time"/"scene" — снятие сценой без дополнительных проверок. */
  cure: CureTrigger[];
  /** Минимальная длительность отдыха/сна за ход для rest/sleep. */
  restMinutes?: number;
};

const RULES: { pattern: RegExp; rule: ConditionRule }[] = [
  { pattern: /тяжело ранен|тяжелое ранение|тяжелая рана|при смерти|на грани/, rule: { label: "Тяжёлое ранение", modifier: -4, scope: "all", durationMinutes: null, note: "Любое усилие даётся с трудом; снимается подтверждённым лечением.", cure: ["medicine", "treatment"] } },
  { pattern: /(^|\s)(ранен|ранени|рана($|\s)|раны($|\s)|кровотеч|перелом|ушиб|вывих|порез)/, rule: { label: "Ранение", modifier: -2, scope: "physical", durationMinutes: null, note: "Физические действия затруднены до лечения.", cure: ["medicine", "treatment"] } },
  { pattern: /(^|\s)(отравлен|отравлени|тошнит|тошнота)/, rule: { label: "Отравление", modifier: -2, scope: "physical", durationMinutes: null, note: "Снимается подтверждённым лечением или приёмом противоядия.", cure: ["medicine", "treatment"] } },
  { pattern: /(^|\s)(болен|больна|болеет|болезн|простуж|простыл|лихорад|жар($|\s))/, rule: { label: "Болезнь", modifier: -1, scope: "all", durationMinutes: null, note: "Снимается подтверждённым лечением.", cure: ["medicine", "treatment"] } },
  { pattern: /(^|\s)(устал|усталост|измотан|изнур|изможд|не выспал|сонлив|без сил)/, rule: { label: "Усталость", modifier: -1, scope: "all", durationMinutes: null, note: "Снимается отдыхом.", cure: ["rest"], restMinutes: 2 * 60 } },
  { pattern: /(^|\s)(пьян|опьянен|нетрезв|под хмельком|навеселе)/, rule: { label: "Опьянение", modifier: -2, scope: "mental", durationMinutes: 4 * 60, note: "Мышление и точность страдают несколько часов.", cure: ["time", "scene"] } },
  { pattern: /испуг|напуган|в страхе|паник|в ужасе/, rule: { label: "Страх", modifier: -2, scope: "mental", durationMinutes: 2 * 60, note: "Мешает сосредоточиться и говорить уверенно.", cure: ["time", "scene"] } },
  { pattern: /в ярости|разъярен|разгневан|в гневе|взбешен/, rule: { label: "Ярость", modifier: -2, scope: "social", durationMinutes: 60, note: "Разговоры и переговоры идут хуже, пока не остынешь.", cure: ["time", "scene"] } },
  { pattern: /под подозрением|подозревают|(^|\s)разыскива|в розыске/, rule: { label: "Под подозрением", modifier: -2, scope: "social", durationMinutes: null, note: "Люди насторожены; снимается только событием истории.", cure: ["scene"] } },
  { pattern: /(^|\s)(промок|мокр|замерз|продрог|озяб)/, rule: { label: "Продрог", modifier: -1, scope: "physical", durationMinutes: 2 * 60, note: "Проходит в тепле.", cure: ["time", "scene"] } },
  { pattern: /(^|\s)(голод|не ел($|\s)|не ела($|\s)|не ели($|\s)|хочет есть)/, rule: { label: "Голод", modifier: -1, scope: "all", durationMinutes: null, note: "Снимается едой.", cure: ["food"] } },
  { pattern: /вдохновл|воодушевл|окрылен|на подъеме/, rule: { label: "Вдохновение", modifier: 2, scope: "all", durationMinutes: 3 * 60, note: "Короткий подъём сил и уверенности.", cure: ["time", "scene"] } },
  { pattern: /(^|\s)(отдохнувш|отдохнул|выспал|бодр(ый|ая|ое|ость)?($|\s)|свеж(ий|ая|а|есть)?$|свежая голова)/, rule: { label: "Отдых", modifier: 1, scope: "all", durationMinutes: 4 * 60, note: "Небольшое преимущество после хорошего отдыха.", cure: ["time", "scene"] } },
  { pattern: /(^|\s)(сосредоточ|собранн?(ый|ая|ость|а)?($|\s)|в потоке)/, rule: { label: "Сосредоточенность", modifier: 1, scope: "mental", durationMinutes: 2 * 60, note: "Помогает в точной и умственной работе.", cure: ["time", "scene"] } },
];

const SKILL_SCOPE: Record<string, ConditionScope> = {
  "Атлетика": "physical", "Акробатика": "physical", "Скрытность": "physical", "Выживание": "physical", "Бой": "physical", "Ближний бой": "physical", "Стрельба": "physical",
  "Убеждение": "social", "Обман": "social", "Запугивание": "social", "Выступление": "social",
  "Восприятие": "mental", "Анализ": "mental", "Магия": "mental", "Взлом": "mental", "Медицина": "mental", "Ремесло": "mental",
};

export const MIN_CONDITION_MODIFIER = -5;
export const MAX_CONDITION_MODIFIER = 3;

// «не ранен», «больше не устала», «ранения нет», «усталость прошла», «рана залечена» — это отсутствие состояния.
const NEGATED = /^(?:не|больше не|уже не) (?:ранен|ранена|болен|больна|отравлен|отравлена|устал|устала|голоден|голодна|испуган|испугана|пьян|пьяна)(?:$|\s)/;
const RESOLVED = /(?: нет| отсутствует| прошла| прошел| прошло| прошли| снята| снято| сняты| снят| вылечен| вылечена| залечен| залечена)$/;

/** Правило из каталога для строки состояния; null — состояние только описательное. */
export function conditionRule(condition: string): ConditionRule | null {
  const text = normName(condition);
  if (!text) return null;
  if (NEGATED.test(text) || RESOLVED.test(text)) return null;
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
//  MECH-4b: снятие длительных состояний только проверяемым событием
// ─────────────────────────────────────────────────────────────
export const CURE_LABELS: Record<CureTrigger, string> = {
  time: "со временем",
  scene: "событием сцены",
  rest: "отдыхом",
  sleep: "сном или долгим отдыхом",
  medicine: "лекарством из инвентаря",
  treatment: "лечением (успешная проверка медицины или оплаченная помощь)",
  food: "едой из инвентаря или оплаченной трапезой",
};

const formatSpan = (minutes: number) => (minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} ч` : `${minutes} мин`);

export function describeCure(rule: ConditionRule): string {
  return rule.cure.map((t) => (t === "rest" || t === "sleep" ? `${CURE_LABELS[t]} от ${formatSpan(rule.restMinutes ?? (t === "rest" ? 120 : 360))}` : CURE_LABELS[t])).join(", ");
}

const FOOD = /(^|\s)(еда|еды|хлеб|паек|пайк|рацион|сыр($|\s)|сыра|яблок|мясо|мяса|суп($|\s)|супа|бутерброд|пирог|пирож|каша|каши|фрукт|консерв|сухар|колбас|ягод|орех|шоколад|булк|булоч|лепешк|похлебк|вялен|сэндвич|бургер|пицц|лапш|рис($|\s)|овощ|food|ration|snack)/;
const MEDICAL_SKILL = /(медиц|лечени|лекар|первая помощь|травнич|целит|врачеван|хирург)/;

/** Проверяемые факты хода, по которым сервер решает, можно ли снять состояние. */
export type RemovalEvidence = {
  intent: IntentKind;
  action?: string;
  heroName?: string;
  /** Сколько минут мира заняло действие (после applyLife). */
  minutes: number;
  /** Предметы, реально использованные (consume, не remove/transfer) из инвентаря в этом ходе. */
  consumed: { name: string; kind?: string }[];
  /** Сколько средств героя ушло в этом ходе. */
  goldSpent: number;
  narration: string;
  dice: { success: boolean; skill?: string } | null;
};

export function removalCheck(rule: ConditionRule, evidence: RemovalEvidence): { ok: boolean; reason: string } {
  if (evidence.intent !== "act") {
    return { ok: false, reason: evidence.intent === "claim" ? "утверждение игрока не снимает состояние" : evidence.intent === "ask" ? "вопрос не снимает состояние" : "намерение ещё не исполнено" };
  }
  const action = normName(evidence.action ?? "");
  const positiveAction = !/(^|\s)(не|никогда|отказываюсь)(\s|$)/.test(action);
  // Deliberately narrow, genre-independent evidence gate. This is a heuristic,
  // not a semantic verifier: a completed hero event AND a relevant action are required.
  const sentences = evidence.narration.split(/[.!?;\n]/).map(normName).filter(s => s && !/(^|\s)(не|нет|без|отказ|отказался|отказалась|если|хотел|хотела|будет|попытался|попыталась)(\s|$)/.test(s));
  const hero = (s: string) => /(^|\s)(ты|тебя|тебе|твою|твои|твое|твоя|вы|вам|вашу|ваши|герой|героиня)(\s|$)/.test(s)
    || !!evidence.heroName && (` ${s} `).includes(` ${normName(evidence.heroName)} `);
  const escapedName = normName(evidence.heroName ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const subject = `(?:ты|вы|герой|героиня${escapedName ? "|" + escapedName : ""})`;
  const completedByHero = (verbs: string) => sentences.some(s => new RegExp(`(?:^|\\s)${subject} (?:наконец |хорошо |успешно )?(?:${verbs})(?:\\s|$)`).test(s));
  const item = (pattern: RegExp) => evidence.consumed.some(i => pattern.test(normName(i.name)));
  const rest = positiveAction && /(^|\s)(отдых|сплю|спать|посп|сон|ложусь|дрем)/.test(action)
    && completedByHero("отдохнул|отдохнула|отдыхал|отдыхала|поспал|поспала|выспался|выспалась|спал|спала");
  const meal = positiveAction && /(^|\s)(ем|есть|съем|съесть|поесть|еду|обед|ужин|завтрак|перекус|съед|заказ)/.test(action)
    && completedByHero("поел|поела|пообедал|пообедала|поужинал|поужинала|позавтракал|позавтракала|перекусил|перекусила|съел|съела");
  const selfTreatment = /(^|\s)(себя|себе|свою|свои|свое|мне|меня|мою|мои)(\s|$)/.test(action);
  const ingestion = /(^|\s)(выпив|приним|выпью|приму)/.test(action) && completedByHero("выпил|выпила|принял|приняла");
  const patientConfirmed = sentences.some(s => hero(s) && /(^|\s)(перевязал[аи]?|зашил[аи]?|обработал[аи]?) (твою|вашу|свою) (рану|руку|ногу|плечо)(\s|$)|(^|\s)(вылечил[аи]?|исцелил[аи]?) (тебя|вас|себя)(\s|$)/.test(s));
  const treated = positiveAction && /(^|\s)(леч|вылеч|перевяз|перевяж|врач|лекар|целит|медиц|противояд|выпив|выпью|прин|приму|бинт|обрабат|обработ|исцел|зелье)/.test(action)
    && ((selfTreatment && patientConfirmed) || ingestion);
  const failedMedical = evidence.dice && !evidence.dice.success && MEDICAL_SKILL.test(normName(evidence.dice.skill ?? ""));
  const medicine = rule.label === "Отравление" ? /противояд|антидот/ : rule.label === "Болезнь" ? /лекарств|антибиотик|микстур|целебн|лечебн/ : /бинт|перевяз|аптечк|кровоостан|зелье (лечения|исцеления|здоровья)|лечебн|целебн/;
  for (const trigger of rule.cure) {
    if (trigger === "time" || trigger === "scene") return { ok: true, reason: "" };
    if ((trigger === "rest" || trigger === "sleep") && rest && evidence.minutes >= (rule.restMinutes ?? 120)) return { ok: true, reason: "" };
    if (trigger === "medicine" && treated && !failedMedical && item(medicine)) return { ok: true, reason: "" };
    if (trigger === "food" && meal && (item(FOOD) || evidence.goldSpent > 0)) return { ok: true, reason: "" };
    if (trigger === "treatment" && treated && !failedMedical && ((evidence.dice?.success && MEDICAL_SKILL.test(normName(evidence.dice.skill ?? ""))) || evidence.goldSpent > 0 || evidence.minutes >= 30)) return { ok: true, reason: "" };
  }
  return { ok: false, reason: `нужно ${describeCure(rule)}${evidence.minutes ? `; за ход прошло ${formatSpan(evidence.minutes)}` : ""}` };
}

/** Какие снятые моделью состояния сервер возвращает герою и почему. Описательные состояния не ограничиваются. */
export function gateConditionRemovals(removed: readonly string[], evidence: RemovalEvidence): { restored: string[]; reasons: string[] } {
  const restored: string[] = [];
  const reasons: string[] = [];
  for (const condition of removed) {
    const rule = conditionRule(condition);
    if (!rule) continue;
    const check = removalCheck(rule, evidence);
    if (!check.ok) { restored.push(condition); reasons.push(`CONDITION: «${condition}» не снято — ${check.reason}`); }
  }
  return { restored, reasons };
}

/** Для промпта: какие события нужны, чтобы снять длительные состояния героя. */
export function describeConditionCures(conditions: readonly string[] | undefined): string {
  const effects = conditionEffects(conditions).filter((e) => !e.rule.cure.includes("time") && !e.rule.cure.includes("scene"));
  if (!effects.length) return "";
  return `\nСНЯТИЕ СОСТОЯНИЙ (сервер снимет состояние только при таком событии в этом ходе, иначе вернёт его): ${effects.map((e) => `«${e.condition}» — ${describeCure(e.rule)}`).join("; ")}. Без такого события не предлагай conditions.remove.`;
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
