// ── Каталог моделей, роутинг задач, промпты, ротация ключей ──
// Квоты 20/500 — ориентиры бесплатного тарифа AI Studio на ключ; сервер учитывает их
// как лимиты (aiSettings.dailyFlashLimit/dailyLiteLimit × число ключей) при enforceLimits.

import { RESOLUTION_RESPONSE_SCHEMA } from "./resolution";

export { RESOLUTION_RESPONSE_SCHEMA };

export const MODEL_CATALOG = [
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    family: "lite" as const,
    tier: "fast-economy",
    dailyLimit: 500,
    role: "Обычные ходы, извлечение фактов, быстрые задачи",
    badge: "≈500 запросов / день / ключ",
    strength: 80,
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    family: "flash" as const,
    tier: "flagship",
    dailyLimit: 20,
    role: "Свободные действия, компакция памяти, ключевые сцены",
    badge: "≈20 запросов / день / ключ",
    strength: 100,
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    family: "flash" as const,
    tier: "fallback-1",
    dailyLimit: 20,
    role: "Фолбэк-1 для сложных задач",
    badge: "≈20 запросов / день / ключ",
    strength: 92,
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    family: "flash" as const,
    tier: "fallback-2",
    dailyLimit: 20,
    role: "Фолбэк-2 для сложных задач",
    badge: "≈20 запросов / день / ключ",
    strength: 85,
  },
] as const;

export type TaskType = "narration" | "resolution" | "compaction" | "fast" | "embedding" | "creation";
export type RoutingProfile = "balanced" | "economy" | "flagship" | "custom";

export type RoutingConfig = {
  profile: RoutingProfile;
  narrationModel: string;
  customActionModel: string;
  compactionModel: string;
  fastTaskModel: string;
};

export const ROUTING_PROFILES: Record<RoutingProfile, { title: string; desc: string; config: Omit<RoutingConfig, "profile"> }> = {
  balanced: {
    title: "⚡ Баланс & Экономия (Рекомендуемый)",
    desc: "Lite для обычных ходов и извлечения фактов. Flash 3.8 для свободных действий и компакции памяти.",
    config: { narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" },
  },
  economy: {
    title: "🌿 Максимальная Экономия",
    desc: "Lite для всех ходов. Flash — только для сжатия памяти.",
    config: { narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.5-flash-lite", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" },
  },
  flagship: {
    title: "👑 Флагманский (Максимум деталей)",
    desc: "Flash 3.8 для всех ходов и компакции. Самое богатое повествование, быстро расходует дневной лимит.",
    config: { narrationModel: "gemini-3.8-flash", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" },
  },
  custom: {
    title: "⚙️ Кастомная настройка",
    desc: "Ручное назначение модели на каждую задачу.",
    config: { narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" },
  },
};

const uniq = (arr: string[]) => arr.filter((m, i) => arr.indexOf(m) === i);

/** Какая задача — какой пул моделей с учётом пользовательской конфигурации. */
export function routeModelsFor(task: TaskType, config?: Partial<RoutingConfig>): string[] {
  const profile = config?.profile ?? "balanced";
  const defaults = ROUTING_PROFILES[profile]?.config ?? ROUTING_PROFILES.balanced.config;
  const narrationTarget = config?.narrationModel || defaults.narrationModel;
  const customTarget = config?.customActionModel || defaults.customActionModel;
  const compactionTarget = config?.compactionModel || defaults.compactionModel;
  const fastTarget = config?.fastTaskModel || defaults.fastTaskModel;

  if (task === "creation") return ["gemini-3.5-flash-lite"];
  if (task === "compaction") return uniq([compactionTarget, "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]);
  if (task === "resolution") return uniq([customTarget, "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]);
  if (task === "fast") return uniq([fastTarget, "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"]);
  if (task === "embedding") return ["gemini-embedding-2"];
  return uniq([narrationTarget, "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"]);
}

export function isLite(model: string) {
  return model.includes("lite");
}

/**
 * DATA-1d: отфильтровать модели, исчерпавшие дневной лимит.
 * usage — число вызовов сегодня по модели; лимит умножается на число ключей (квота на ключ).
 */
export function filterByDailyLimits(
  models: string[],
  usage: Record<string, number>,
  limits: { flash: number; lite: number },
  keyCount: number,
): { allowed: string[]; skipped: string[] } {
  const k = Math.max(1, keyCount);
  const allowed: string[] = [];
  const skipped: string[] = [];
  for (const m of models) {
    const cap = (isLite(m) ? limits.lite : limits.flash) * k;
    if ((usage[m] ?? 0) >= cap) skipped.push(m);
    else allowed.push(m);
  }
  return { allowed, skipped };
}

/** Грубая оценка токенов: ~3.6 символа = 1 токен (RU/EN смесь). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.6));
}

/** Ключи из окружения (GEMINI_API_KEYS="k1,k2") объединяются с ключами из БД. */
export function envKeys(): string[] {
  const raw = process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? "";
  return [...new Set(raw.split(/[\n,;]+/).map((k) => k.trim()).filter((k) => k.length > 10))].slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
//  Промпты
// ─────────────────────────────────────────────────────────────
export type TurnPromptContext = {
  mode: "choice" | "free";
  campaignMode: "preset" | "free";
  profileCanon: string;
  tone: string;
  worldName: string;
  scenarioPrompt: string;
  characterLine: string;
  worldLine: string;
  location: string;
  inventoryDigest: string;
  questsDigest: string;
  npcsDigest: string;
  sceneDigest: string;
  locationsDigest?: string;
  memoryDigest: string;
  retrievedDigest: string;
  recentTurns: string;
  diceBlock: string;
  playerAction: string;
};

/**
 * Единый системный промпт хода (narration и resolution). Bookending: ключевые правила
 * повторены в хвосте — против U-образного провала внимания на длинных контекстах.
 */
export function buildTurnSystemPrompt(c: TurnPromptContext): string {
  const role =
    c.mode === "free"
      ? "Ты — ведущий интерактивной истории и движок разрешения свободных действий."
      : "Ты — ведущий интерактивной истории; игрок выбрал один из предложенных вариантов.";
  const freeRules =
    c.mode === "free"
      ? `Игрок совершает свободное действие. Оцени его правдоподобие в рамках сеттинга, канона, состояния героя, инвентаря и сцены.
· Игрок может взаимодействовать с любым объектом, который логично существует в сцене; невозможное или противоречащее канону — проваливай логично.
· Использовать можно ТОЛЬКО предметы из списка инвентаря (ссылайся на них через ref «#id»). Новый предмет допустим только если он правдоподобно появился в этой сцене (op "add").`
      : `Развивай сцену по выбранному варианту: последствия должны быть конкретными и продвигать историю.`;

  return `${role} Язык — русский, второе лицо, живой кинематографичный стиль, 120–220 слов нарратива.
Тон и жанр: ${c.tone}. Мир: ${c.worldName}. Строго держи атмосферу и лексикон жанра — никаких фэнтезийных клише в современном или научно-фантастическом мире и наоборот.
${c.profileCanon}
Режим кампании: ${c.campaignMode === "preset" ? "авторский пресет — держись заданной истории, фракций и мест" : "свободная кампания — мир строится вокруг канона игрока; не навязывай чужие тропы"}.

ПЕРСОНАЖ: ${c.characterLine}
МИР: ${c.worldLine}
ПРЕДЫСТОРИЯ/КАНОН МИРА: ${c.scenarioPrompt}
ЛОКАЦИЯ СЕЙЧАС: ${c.location}
ИНВЕНТАРЬ (единственный источник предметов героя): ${c.inventoryDigest}
ЦЕЛИ/КВЕСТЫ: ${c.questsDigest}
ИЗВЕСТНЫЕ ПЕРСОНАЖИ (NPC): ${c.npcsDigest}
ОБЪЕКТЫ СЦЕНЫ: ${c.sceneDigest}
ИЗВЕСТНАЯ КАРТА: ${c.locationsDigest ?? "Начало исследования"}

ПАМЯТЬ КАНОНА (не противоречь): ${c.memoryDigest}
${c.retrievedDigest ? `РЕЛЕВАНТНЫЕ ВОСПОМИНАНИЯ ДЛЯ ЭТОГО ДЕЙСТВИЯ: ${c.retrievedDigest}` : ""}

${freeRules}
${c.diceBlock}

ФОРМАТ ОТВЕТА — строго JSON по схеме. Правила заполнения:
· narration — художественный текст последствий; не пиши в нём цифры механики и не перечисляй изменения списком.
· outcome — success | partial | failure | neutral (при наличии результата проверки — согласуй с ним).
· effects — целые числа; в профилях без HP/опыта/золота ставь 0. danger — изменение накала сцены.
· stateChanges.location — action "move" только если герой РЕАЛЬНО переместился в другое место; "discover" — если узнал о новом месте; иначе "none".
· stateChanges.locations — все места, о которых герой действительно узнал в этом ходе (например, изучая карту); допускается несколько. Для известных мест ref — точный ID или уникальное имя из карты; для новых ref пустой, укажи name, description, danger.
· stateChanges.routes — только явно установленные в рассказе проходимые связи: from/to — точные ID или уникальные имена известных или открытых в этом ходе мест. Не выдумывай связь из простого совместного упоминания. Найденная карта должна отразиться в locations и routes согласно её содержанию.
· Служебные ID/ref используются только в структурированных изменениях; не показывай их в narration и choices.
· stateChanges.quests — обновляй существующие по ref (key), новые цели — с пустым ref. Не завершай квест без реального выполнения.
· stateChanges.npcs — ref = key известного NPC; relationDelta −30…+30; новых персонажей вводи только если они появились в сцене.
· stateChanges.inventory — op consume/remove/equip/unequip только с ref из инвентаря; op add — с описанием и kind (weapon, armor, consumable, quest, tool, document, tech, misc).
· stateChanges.sceneObjects — объекты окружения, чьё состояние изменилось или которые стали значимы.
· stateChanges.conditions — состояния героя (ранен, измотан, разоблачён, воодушевлён…), до 4 за ход.
· choices — ровно 3 коротких, разных по духу варианта следующего действия (риск / осторожность / общение).

НАПОМИНАНИЕ: тон «${c.tone}», локация «${c.location}», не противоречь памяти и списку инвентаря, ${c.diceBlock ? "нарратив обязан соответствовать результату проверки, " : ""}ответ — только JSON.`;
}

export function buildTurnUserPrompt(c: TurnPromptContext): string {
  return `Последние события:\n${c.recentTurns}\n\n${c.mode === "free" ? "Свободное действие игрока" : "Выбранный вариант"}: ${c.playerAction}`;
}

export function buildDiceBlock(d: { goal?: string; kind?: string; skill: string; d20: number; modifier: number; total: number; dc: number; success: boolean; critical: string | null; band?: string } | null): string {
  if (!d) return "";
  if (d.kind === "2d6") {
    const a = Math.floor(d.d20 / 10);
    const b = d.d20 % 10;
    const bandRu = d.band === "full" ? "ПОЛНЫЙ УСПЕХ" : d.band === "cost" ? "УСПЕХ С ЦЕНОЙ (цель достигнута, но есть осложнение или потеря)" : "ПРОВАЛ (цель не достигнута, ситуация ухудшается)";
    return `${d.goal ? `\nПРОВЕРЯЕМАЯ ЦЕЛЬ: ${JSON.stringify(d.goal)}.` : ""}\nРЕЗУЛЬТАТ РИСК-ПРОВЕРКИ (факт сервера, не меняй): ${d.skill}: 2d6 = ${a}+${b}${d.modifier ? (d.modifier > 0 ? `+${d.modifier}` : d.modifier) : ""} → ${bandRu}. Нарратив ОБЯЗАН соответствовать этому исходу.`;
  }
  const outcomeRu =
    d.critical === "crit"
      ? "КРИТИЧЕСКИЙ УСПЕХ (d20=20) — герой добивается большего, чем хотел"
      : d.critical === "fumble"
        ? "КРИТИЧЕСКАЯ НЕУДАЧА (d20=1) — провал с осложнением"
        : d.success
          ? `УСПЕХ (${d.total} ≥ DC ${d.dc})`
          : `НЕУДАЧА (${d.total} < DC ${d.dc})`;
  return `${d.goal ? `\nПРОВЕРЯЕМАЯ ЦЕЛЬ: ${JSON.stringify(d.goal)}.` : ""}\nРЕЗУЛЬТАТ БРОСКА (факт сервера, не меняй): навык «${d.skill}», d20=${d.d20}${d.modifier >= 0 ? "+" : ""}${d.modifier} = ${d.total} vs DC ${d.dc} → ${outcomeRu}. Если УСПЕХ — цель достигнута (полностью или в основном); если НЕУДАЧА — цель не достигнута и есть последствия. Нарратив ОБЯЗАН соответствовать.`;
}

export function buildCompactionSystemPrompt(profileCanon: string): string {
  return `Ты — модуль Memory House интерактивной истории. Сожми блок ходов в структурированную память БЕЗ потери канона.
${profileCanon}
Верни СТРОГО валидный JSON без текста вне него:
{
  "episodic": [ { "title": "...", "content": "Событие с причиной и следствием", "importance": 0-100, "entityKey": "quest:key | npc:key | location:slug | event" } ],
  "semantic": [ { "title": "...", "content": "Устойчивый факт о мире, NPC, месте или предмете", "importance": 0-100, "entityKey": "npc:key | location:slug | item:slug | world" } ],
  "chronicle": "3-5 предложений: ключевые события главы, причинно-следственные связи, потери, обязательства"
}
Правила важности: ≥85 — смерти, клятвы/долги, уникальные предметы, потеря союзников; ≥70 — квесты, именные NPC, смена сторон, тяжёлые раны; ≥55 — новые предметы, места, переговоры; <40 — антураж, отбрасывай.
Канон: не меняй имена, не противоречь существующей памяти, НЕ дублируй уже зафиксированные факты — только новое и изменившееся. Русский язык.`;
}

// ─────────────────────────────────────────────────────────────
//  MEM-1: schema-constrained semantic extractor (fastTaskModel)
// ─────────────────────────────────────────────────────────────
export const EXTRACTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["npc", "world", "character", "relationship", "promise", "secret", "event"] },
          entityKey: { type: "string", description: "npc:<имя-slug> | location:<slug> | character:<аспект> | world:<тема> | пусто" },
          title: { type: "string" },
          content: { type: "string", description: "Один самодостаточный факт, 1–2 предложения" },
          evidence: { type: "string", description: "Короткая цитата из текста хода, подтверждающая факт" },
          importance: { type: "integer" },
          confidence: { type: "number", description: "0..1" },
        },
        required: ["type", "entityKey", "title", "content", "evidence", "importance", "confidence"],
      },
    },
  },
  required: ["facts"],
};

export function buildExtractionSystemPrompt(profileCanon: string, alreadyKnown: string): string {
  return `Ты — извлекатель канонических фактов для памяти интерактивной истории.
${profileCanon}
Из текста хода извлеки ТОЛЬКО факты, которых ещё нет в состоянии игры и в известной памяти: имена и роли персонажей, мотивы, обещания и долги, секреты, устойчивые сведения о мире, изменившиеся отношения, важные события.
НЕ извлекай: изменения HP/опыта/золота, полученные или использованные предметы, переходы между локациями, статусы квестов — эти факты сервер уже записал из состояния.
Каждый факт: тип, entityKey (если есть сущность), заголовок, содержание, дословная цитата-доказательство из текста, importance 40–95, confidence 0–1. Не выдумывай. Если новых фактов нет — верни пустой массив.
УЖЕ ИЗВЕСТНО (не дублируй): ${alreadyKnown}
Русский язык. Ответ — только JSON по схеме.`;
}

// ─────────────────────────────────────────────────────────────
//  Вызов Gemini REST (v1beta) с ротацией ключей и цепочкой моделей
// ─────────────────────────────────────────────────────────────
export { callGeminiWithRotation, type AttemptInfo } from "./gemini-transport";
