// ── Memory House: 5 слоёв памяти + сборка контекста с бюджетом ──
// working (последние N ходов дословно) → episodic (события) → semantic (факты о мире)
// → procedural (правила/механики) → chronicle (сводка глав). Именно так избегаем
// раздувания до 250k+ и бездумной компакции: важное всплывает по salience.
//
// Sweet-spot по данным RULER-benchmark и "Lost in the Middle" исследований:
//   Lite  (3.5-flash-lite): 4 000 – 7 500 токенов → надёжный нарратив без амнезии
//   Flash (3.8-flash):      12 000 – 18 000 токенов для ходов; 16 000 – 28 000 для компакции

export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "chronicle";

/** ModelTier — определяет, какой объём контекста допустим при данной задаче. */
export type ModelTier = "lite" | "flash";

export const LAYER_INFO: Record<MemoryLayer, { label: string; icon: string; hint: string; budget: number }> = {
  chronicle:  { label: "Хроника глав",  icon: "📜", hint: "Главные вехи и итоги пройденного пути",  budget: 3500 },
  episodic:   { label: "События",        icon: "📖", hint: "Ключевые решения, встречи и последствия", budget: 5000 },
  semantic:   { label: "Знания о мире",  icon: "🧠", hint: "NPC, локации, реликвии и факты",          budget: 4000 },
  procedural: { label: "Правила",        icon: "⚙️", hint: "Особенности персонажа и мира",             budget: 2000 },
  working:    { label: "Недавнее",       icon: "⚡", hint: "Детали последних минут приключения",       budget: 4000 },
};

/**
 * Суммарный бюджет контекста памяти по tier модели.
 * Lite  (3.5-flash-lite): 7 500 токенов ≈ safe-zone до U-образного падения внимания.
 * Flash (3.8-flash):      16 000 токенов ≈ надёжная зона с расширенным рассуждением.
 */
export const CONTEXT_BUDGET: Record<ModelTier, number> = {
  lite:  7_500,
  flash: 16_000,
};

/** Устаревшее имя, оставлено для совместимости с UI-компонентами. */
export const TOTAL_CONTEXT_BUDGET = CONTEXT_BUDGET.flash;

export type MemoryNodeInput = {
  layer: MemoryLayer;
  category: string;
  title: string;
  content: string;
  importance: number;
  turnFrom?: number;
  turnTo?: number;
  parentId?: string | null;
};

export function importanceScore(opts: {
  category: string;
  mentionsDeath?: boolean;
  mentionsItem?: boolean;
  mentionsPromise?: boolean;
  isQuest?: boolean;
  turnAge?: number;
}): number {
  let s = 45;
  if (opts.isQuest) s += 25;
  if (opts.mentionsDeath) s += 25;
  if (opts.mentionsItem) s += 12;
  if (opts.mentionsPromise) s += 15;
  if (opts.category === "npc") s += 8;
  if (opts.category === "rule") s += 5;
  if (typeof opts.turnAge === "number") s -= Math.min(20, opts.turnAge * 0.5);
  return Math.max(5, Math.min(100, Math.round(s)));
}

/** Эвристика: извлекает кандидатов в память из текста хода (для lite-модели и офлайна). */
export function extractMemoryCandidates(text: string, turnNumber: number): MemoryNodeInput[] {
  const out: MemoryNodeInput[] = [];
  const has = (...ws: string[]) => ws.some((w) => text.toLowerCase().includes(w.toLowerCase()));
  if (has("умер", "смерть", "погиб", "убит", "кровь", "рана")) {
    out.push({
      layer: "episodic",
      category: "event",
      title: `Кровь и раны — ход ${turnNumber}`,
      content: text.slice(0, 400),
      importance: 82,
      turnFrom: turnNumber,
      turnTo: turnNumber,
    });
  }
  if (has("обеща", "клян", "договор", "пакт", "квест", "задание", "просьба")) {
    out.push({
      layer: "episodic",
      category: "quest",
      title: `Обещание/квест — ход ${turnNumber}`,
      content: text.slice(0, 400),
      importance: 78,
      turnFrom: turnNumber,
      turnTo: turnNumber,
    });
  }
  const itemMatch = text.match(/(нашёл|нашла|получил|получила|подобрал|забрал|мечь?|клинок|амулет|зелье|карта|ключ|кольцо|свиток|золото|кинжал|лук|щит)/i);
  if (itemMatch) {
    out.push({
      layer: "semantic",
      category: "item",
      title: `Предмет: ${itemMatch[0]} — ход ${turnNumber}`,
      content: text.slice(0, 300),
      importance: 62,
      turnFrom: turnNumber,
      turnTo: turnNumber,
    });
  }
  const npcMatch = text.match(/(назван|зовут|по имени|встретил|встретила)\s+([А-ЯЁ][а-яё]+)/);
  if (npcMatch) {
    out.push({
      layer: "semantic",
      category: "npc",
      title: `NPC: ${npcMatch[2]}`,
      content: text.slice(0, 300),
      importance: 70,
      turnFrom: turnNumber,
      turnTo: turnNumber,
    });
  }
  return out;
}

/**
 * Сборка дайджеста памяти для промпта с учётом бюджета, salience и tier модели.
 *
 * Lite  → макс 8 000 символов (~2 200 токенов), до 12 нод на слой, 350 симв/нода.
 * Flash → макс 14 000 символов (~3 800 токенов), до 20 нод на слой, 500 симв/нода.
 *
 * Порядок слоёв (bookending-aware): хроника и семантика идут первыми (primacy — в начало,
 * чтобы канон был в «горячей» зоне внимания), активные эпизоды — ближе к хвосту (recency).
 */
export function assembleMemoryDigest(
  nodes: { layer: string; title: string; content: string; importance: number; salience: number }[],
  tier: ModelTier = "lite",
): string {
  if (!nodes.length) return "Пока пусто — начало истории.";

  const maxCharsPerNode = tier === "flash" ? 500 : 350;
  const maxNodesPerLayer = tier === "flash" ? 20 : 12;
  const hardCap = tier === "flash" ? 14_000 : 8_000;

  const sorted = [...nodes].sort(
    (a, b) => b.importance * 0.7 + b.salience * 0.3 - (a.importance * 0.7 + a.salience * 0.3),
  );
  const perLayer: Record<string, typeof nodes> = {};
  for (const n of sorted) {
    perLayer[n.layer] ??= [];
    if (perLayer[n.layer].length < maxNodesPerLayer) perLayer[n.layer].push(n);
  }
  const parts: string[] = [];
  // chronicle/semantic → primacy (начало, высокий вес внимания); episodic → recency (конец)
  for (const layer of ["chronicle", "semantic", "procedural", "episodic"] as const) {
    const arr = perLayer[layer];
    if (arr?.length) {
      parts.push(
        `[${layer.toUpperCase()}] ` +
          arr.map((n) => `${n.title}: ${n.content.slice(0, maxCharsPerNode)}`).join(" ‖ "),
      );
    }
  }
  const joined = parts.join("\n");
  return joined.length > hardCap ? joined.slice(0, hardCap) + "…" : joined;
}

/**
 * Когда пора компактить:
 *   - прошло ≥ 24 хода с последней компакции (с 14, чтобы снизить частоту и экономить квоты)
 *   - ИЛИ рабочая память превысила бюджет рабочего слоя
 *
 * Используется в act/route.ts: возвращает needsCompaction: true в ответе клиенту,
 * который затем вызывает /compact на следующем взаимодействии (избегаем inline задержки хода).
 */
export function shouldCompact(turnCount: number, lastCompactTurn: number, workingTokens: number): boolean {
  return turnCount - lastCompactTurn >= 24 || workingTokens > LAYER_INFO.working.budget;
}
