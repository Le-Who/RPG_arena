// ── NARR-9: «Ранее в истории» ──
// Детерминированное резюме перед продолжением: собирается из подтверждённого состояния кампании
// (мир, герой, квесты, отношения, договорённости, повестка) и уже сохранённых узлов памяти.
// AI не вызывается; старые записи памяти могут содержать неполные или устаревшие сведения.
import type { CharacterState, WorldState } from "@/db/schema";
import { commitmentAlerts, formatClock, readLife, COMMITMENT_LABELS, STORY_SHAPE_LABELS } from "./world-life";
import { agendaAlerts, readAgenda } from "./world-agenda";
import { conditionEffects } from "./conditions";

export type RecapMemory = { layer: string; category: string; title: string; content: string; importance: number; turnTo?: number | null; sourceTurn?: number | null };
export type RecapQuest = { title: string; status: string; progress: number; isMain: boolean };
export type RecapNpc = { name: string; role: string; relation: number; status: string; lastSeenTurn: number; lastLocation: string };
export type RecapTurn = { turnNumber: number; role: string; content: string; createdAt?: Date | string | null };

export type RecapInput = {
  title: string;
  rulesProfile?: string;
  character: CharacterState;
  world: WorldState;
  turnCount: number;
  memories: RecapMemory[];
  quests: RecapQuest[];
  npcs: RecapNpc[];
  recentTurns: RecapTurn[];
  updatedAt?: Date | string | null;
  now?: Date;
};

export type RecapSection = { id: string; title: string; lines: string[] };
export type Recap = {
  headline: string;
  awayLabel: string | null;
  sections: RecapSection[];
  /** Готовый Markdown для экспорта/буфера обмена. */
  markdown: string;
  finished: boolean;
};

const RETURN_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, max: number) => { const line = oneLine(s); return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line; };

export function relationLabel(relation: number): string {
  if (relation >= 60) return "близкий союзник";
  if (relation >= 25) return "расположен";
  if (relation > -25) return "нейтрален";
  if (relation > -60) return "недоволен";
  return "враждебен";
}

/** Сколько прошло с последнего хода; null — недавно. */
export function awaySince(updatedAt: Date | string | null | undefined, now = new Date()): string | null {
  if (!updatedAt) return null;
  const then = new Date(updatedAt).getTime();
  if (!Number.isFinite(then)) return null;
  const ms = now.getTime() - then;
  if (ms < RETURN_THRESHOLD_MS) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн. назад`;
  return `${Math.floor(days / 30)} мес. назад`;
}

export function shouldOfferRecap(input: { turnCount: number; updatedAt?: Date | string | null; now?: Date }): boolean {
  return input.turnCount >= 3 && awaySince(input.updatedAt, input.now) !== null;
}

/** Session.updatedAt can change when settings are edited; prefer the saved narrator turn. */
export function recapLastTurnAt(turns: readonly { role: string; createdAt?: Date | string | null }[], fallback?: Date | string | null): Date | string | null {
  return [...turns].reverse().find((turn) => turn.role === "narrator" && turn.createdAt)?.createdAt ?? fallback ?? null;
}

export function buildRecap(input: RecapInput): Recap {
  const life = readLife(input.world);
  const agenda = readAgenda(input.world);
  const alerts = commitmentAlerts(life);
  const agendaState = agendaAlerts(agenda, life.clock);
  const sections: RecapSection[] = [];
  const finished = life.story.status === "resolved";

  // Где мы и когда
  const where: string[] = [`${formatClock(life.clock)} · ${input.world.currentLocation || "место не определено"}`];
  where.push(`${STORY_SHAPE_LABELS[life.story.kind].title}${finished ? " — завершена" : ""}, глава ${input.world.chapter}, ходов: ${input.turnCount}`);
  if (life.story.kind === "arc" && life.story.goal) where.push(`Цель: ${life.story.goal}${life.story.endCondition ? ` (финал, когда ${life.story.endCondition})` : ""}`);
  if (life.story.kind !== "arc" && life.story.focus.length) where.push(`В фокусе: ${life.story.focus.join("; ")}`);
  sections.push({ id: "where", title: "Где мы", lines: where });

  // Герой
  const hero: string[] = [];
  const c = input.character;
  hero.push(`${c.name}${c.archetype ? `, ${c.archetype}` : ""}${c.level > 1 ? `, уровень ${c.level}` : ""}`);
  if (c.conditions?.length) {
    const effects = input.rulesProfile === "narrative" ? [] : conditionEffects(c.conditions);
    hero.push(`Состояния: ${c.conditions.join(", ")}${effects.length ? ` (${effects.map((e) => `${e.condition} ${e.rule.modifier > 0 ? "+" : ""}${e.rule.modifier}`).join(", ")})` : ""}`);
  }
  sections.push({ id: "hero", title: "Герой", lines: hero });

  // Что произошло — хроника и важнейшие события, в порядке времени
  const chronicle = input.memories.filter((m) => m.layer === "chronicle").sort((a, b) => (a.turnTo ?? 0) - (b.turnTo ?? 0)).slice(-4);
  const events = input.memories.filter((m) => m.layer === "episodic" && m.importance >= 55).sort((a, b) => (b.sourceTurn ?? b.turnTo ?? 0) - (a.sourceTurn ?? a.turnTo ?? 0)).slice(0, 6).reverse();
  const happened = [...chronicle.map((m) => clip(m.content.replace(/^\[[^\]]*\]\s*/, ""), 220)), ...events.map((m) => `${m.title}${m.sourceTurn ? ` (ход ${m.sourceTurn})` : ""}`)];
  if (!happened.length) {
    const lastNarration = [...input.recentTurns].reverse().find((t) => t.role !== "player");
    if (lastNarration) happened.push(clip(lastNarration.content, 300));
  }
  if (happened.length) sections.push({ id: "happened", title: "Что произошло", lines: happened });

  // Открытые линии: квесты, договорённости, события повестки
  const open: string[] = [];
  for (const q of input.quests.filter((q) => q.status === "active").sort((a, b) => Number(b.isMain) - Number(a.isMain)).slice(0, 5)) open.push(`${q.isMain ? "★ " : ""}${q.title}${q.progress > 0 ? ` — ${q.progress}%` : ""}`);
  for (const cm of life.commitments.filter((cm) => cm.status === "accepted" || cm.status === "proposed").slice(-5)) {
    const flag = alerts.overdue.some((a) => a.id === cm.id) ? " · просрочено" : alerts.due.some((a) => a.id === cm.id) ? " · скоро" : "";
    open.push(`${cm.title} [${COMMITMENT_LABELS[cm.status].toLowerCase()}]${cm.due ? ` — ${formatClock(cm.due)}` : ""}${flag}`);
  }
  for (const e of agendaState.due) open.push(`Наступило: ${e.title}`);
  for (const e of agendaState.upcoming.slice(0, 4)) open.push(`Скоро: ${e.title} — ${formatClock(e.at)}`);
  if (open.length) sections.push({ id: "open", title: "Открытые линии", lines: open });

  // Люди
  const people = input.npcs.filter((n) => n.status !== "dead").sort((a, b) => Math.abs(b.relation) - Math.abs(a.relation) || b.lastSeenTurn - a.lastSeenTurn).slice(0, 6)
    .map((n) => { const goal = agenda.npcAgendas.find((a) => a.name === n.name); return `${n.name}${n.role ? ` (${n.role})` : ""} — ${relationLabel(n.relation)}${goal?.goal ? `; хочет ${goal.goal}` : ""}${n.lastLocation ? `; виделись: ${n.lastLocation}` : ""}`; });
  if (people.length) sections.push({ id: "people", title: "Люди", lines: people });

  // Последний момент
  const lastPlayer = [...input.recentTurns].reverse().find((t) => t.role === "player");
  const lastNarrator = [...input.recentTurns].reverse().find((t) => t.role !== "player");
  const last: string[] = [];
  if (lastPlayer) last.push(`Вы: ${clip(lastPlayer.content, 160)}`);
  if (lastNarrator) last.push(clip(lastNarrator.content, 360));
  if (finished && life.story.epilogue) last.push(`Эпилог: ${clip(life.story.epilogue, 400)}`);
  if (last.length) sections.push({ id: "last", title: finished ? "Финал" : "Последний момент", lines: last });

  const awayLabel = awaySince(recapLastTurnAt(input.recentTurns, input.updatedAt), input.now);
  const headline = finished ? `«${input.title}» завершена` : awayLabel ? `Ранее в «${input.title}»` : `Кратко о «${input.title}»`;
  const markdown = [`## ${oneLine(headline)}`, ...sections.flatMap((s) => [``, `### ${oneLine(s.title)}`, ...s.lines.map((l) => `- ${oneLine(l)}`)])].join("\n");
  return { headline, awayLabel, sections, markdown, finished };
}
