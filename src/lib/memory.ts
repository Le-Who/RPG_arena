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
  // `working` — концептуальный/UI слой. Реальная рабочая память это recentTurns,
  // который вставляется напрямую в промпт, а не хранится как ноды в БД.
  // budget здесь используется только как fallback-порог в shouldCompact.
  working:    { label: "Недавнее",       icon: "⚡", hint: "Последние ходы (вставляются в промпт напрямую)", budget: 4000 },
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

/**
 * @deprecated Используй `CONTEXT_BUDGET[tier]`.
 * Оставлено только для обратной совместимости.
 */
export const TOTAL_CONTEXT_BUDGET = CONTEXT_BUDGET.flash;

export type MemoryNodeInput = {
  layer: Exclude<MemoryLayer, "working">;
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

  // Fix #8: «золото» исключено — встречается почти в каждом успешном ходу (offline engine),
  // не является конкретным предметом и порождает мусорные ноды (50+ штук за кампанию).
  // Баланс золота всегда присутствует в промпте через charLine (character.gold).
  const itemKeywords = [
    "клинок", "меч", "кинжал", "лук", "щит",
    "амулет", "зелье", "свиток", "кольцо", "артефакт",
    "ключ", "карта", "реликвия", "посох",
  ];
  const foundItems = new Set<string>();
  for (const kw of itemKeywords) {
    if (text.toLowerCase().includes(kw)) {
      foundItems.add(kw);
      out.push({
        layer: "semantic",
        category: "item",
        title: `Предмет: ${kw} — ход ${turnNumber}`,
        content: text.slice(0, 300),
        importance: 62,
        turnFrom: turnNumber,
        turnTo: turnNumber,
      });
      if (foundItems.size >= 2) break;
    }
  }

  // Поиск NPC (поддержка кириллицы и латиницы)
  const npcRegex = /(?:назван[а-я]*|зовут|по имени|встретил[а-я]*)\s+([A-ZА-ЯЁ][a-zа-яё]+)/gi;
  const foundNpcs = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = npcRegex.exec(text)) !== null) {
    const name = match[1];
    if (name && !foundNpcs.has(name.toLowerCase())) {
      foundNpcs.add(name.toLowerCase());
      out.push({
        layer: "semantic",
        category: "npc",
        title: `NPC: ${name}`,
        content: text.slice(0, 300),
        importance: 70,
        turnFrom: turnNumber,
        turnTo: turnNumber,
      });
      if (foundNpcs.size >= 2) break;
    }
  }

  // Fix #6: working-слой зарезервирован исключительно для in-memory контекста (recentTurns),
  // ноды памяти в БД никогда не должны попадать в working.
  return out.filter((c) => (c.layer as string) !== "working");
}

/**
 * Сборка дайджеста памяти для промпта с учётом бюджета, salience, decay и tier модели.
 *
 * Lite  → макс 8 000 символов (~2 200 токенов), до 12 нод на слой, 350 симв/нода.
 * Flash → макс 14 000 символов (~3 800 токенов), до 20 нод на слой, 500 симв/нода.
 *
 * Salience decay: старые ноды теряют вес в ранжировании (~0.3 пункта/ход, макс 30).
 * Chronicle-слой не декается — летопись всегда релевантна независимо от возраста.
 *
 * Порядок слоёв (bookending-aware): хроника и семантика идут первыми (primacy),
 * активные эпизоды — ближе к хвосту (recency).
 */
export function assembleMemoryDigest(
  nodes: { layer: string; title: string; content: string; importance: number; salience: number; turnTo?: number }[],
  tier: ModelTier = "lite",
  currentTurn = 0,
): string {
  if (!nodes.length) return "Пока пусто — начало истории.";

  const maxCharsPerNode = tier === "flash" ? 500 : 350;
  const maxNodesPerLayer = tier === "flash" ? 20 : 12;
  const hardCap = tier === "flash" ? 14_000 : 8_000;

  // Salience decay: чем старее нода, тем ниже её эффективный вес в ранжировании.
  // Chronicle не декается — исторические летописи всегда критичны.
  const effectiveSalience = (n: (typeof nodes)[0]): number => {
    if (n.layer === "chronicle" || !currentTurn || !n.turnTo) return n.salience;
    const age = Math.max(0, currentTurn - n.turnTo);
    const decay = Math.min(30, age * 0.3);
    return Math.max(0, n.salience - decay);
  };

  const sorted = [...nodes].sort(
    (a, b) =>
      b.importance * 0.7 + effectiveSalience(b) * 0.3 -
      (a.importance * 0.7 + effectiveSalience(a) * 0.3),
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
 *   - прошло >= 24 реальных действий игрока с последней компакции
 *   - ИЛИ рабочая память превысила порог workingBudget
 *
 * ВАЖНО (Fix #6): первый аргумент `turnCount` должен быть числом РЕАЛЬНЫХ действий
 * игрока (role = "player") с момента последней компакции, а НЕ session.turnCount.
 * Dice-записи (+1 к turnNumber за каждый бросок) не являются действиями игрока
 * и раньше приближали порог компакции вдвое быстрее нужного.
 *
 * Правильный вызов из act/route.ts:
 *   shouldCompact(playerTurnsSinceCompact, 0, workingTokens, workingBudget)
 * Второй аргумент = 0, т.к. SQL-фильтр gt(turnNumber, lastCompactTurn) уже
 * выполнил отсечение — счётчик начинается с нуля.
 *
 * workingBudget передаётся из act/route.ts с учётом tier модели:
 *   Lite  → LAYER_INFO.working.budget (4 000 токенов)
 *   Flash → 8 000 токенов
 *
 * Возвращает needsCompaction: true → клиент вызывает /compact фоново.
 */
export function shouldCompact(
  turnCount: number,
  lastCompactTurn: number,
  workingTokens: number,
  workingBudget = LAYER_INFO.working.budget,
): boolean {
  return turnCount - lastCompactTurn >= 24 || workingTokens > workingBudget;
}
