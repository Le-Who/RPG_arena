// ── Memory House: 5 слоёв памяти + сборка контекста с бюджетом ──
// working (последние N ходов дословно) → episodic (события) → semantic (факты о мире)
// → procedural (правила/механики) → chronicle (сводка глав). Именно так избегаем
// раздувания до 250k+ и бездумной компакции: важное всплывает по salience.

export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "chronicle";

export const LAYER_INFO: Record<MemoryLayer, { label: string; icon: string; hint: string; budget: number }> = {
  chronicle: { label: "Хроника глав", icon: "📜", hint: "Главные вехи и итоги пройденного пути", budget: 2500 },
  episodic: { label: "События", icon: "📖", hint: "Ключевые решения, встречи и последствия", budget: 4000 },
  semantic: { label: "Знания о мире", icon: "🧠", hint: "NPC, локации, реликвии и факты", budget: 3000 },
  procedural: { label: "Правила", icon: "⚙️", hint: "Особенности персонажа и мира", budget: 1500 },
  working: { label: "Недавнее", icon: "⚡", hint: "Детали последних минут приключения", budget: 6000 },
};

export const TOTAL_CONTEXT_BUDGET = 17000; // токенов на собранный контекст (далеко от 250k деградации)

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

/** Сборка дайджеста памяти для промпта с учётом бюджета и salience. */
export function assembleMemoryDigest(
  nodes: { layer: string; title: string; content: string; importance: number; salience: number }[],
): string {
  if (!nodes.length) return "Пока пусто — начало истории.";
  const sorted = [...nodes].sort((a, b) => b.importance * 0.7 + b.salience * 0.3 - (a.importance * 0.7 + a.salience * 0.3));
  const perLayer: Record<string, typeof nodes> = {};
  for (const n of sorted) {
    perLayer[n.layer] ??= [];
    if (perLayer[n.layer].length < 8) perLayer[n.layer].push(n);
  }
  const parts: string[] = [];
  for (const layer of ["chronicle", "semantic", "episodic", "procedural"] as const) {
    const arr = perLayer[layer];
    if (arr?.length) {
      parts.push(`[${layer.toUpperCase()}] ` + arr.map((n) => `${n.title}: ${n.content.slice(0, 220)}`).join(" ‖ "));
    }
  }
  const joined = parts.join("\n");
  // жёсткий кап ~ 4000 символов ≈ 1100 токенов
  return joined.length > 4000 ? joined.slice(0, 4000) + "…" : joined;
}

/** Когда пора компактить: >14 ходов с последней компакции или рабочая память > бюджета. */
export function shouldCompact(turnCount: number, lastCompactTurn: number, workingTokens: number): boolean {
  return turnCount - lastCompactTurn >= 14 || workingTokens > LAYER_INFO.working.budget;
}
