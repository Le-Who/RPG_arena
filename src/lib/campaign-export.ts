import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { agreementEvents, gameSessions, gameTurns } from "@/db/schema";
import { readCampaignSnapshot } from "./campaign-copy";
import { createPortableDocument } from "./campaign-portable";
import { requireUuid } from "./http";
import { formatClock, readLife, STORY_SHAPE_LABELS } from "./world-life";

/** A repeatable-read view covers every table even while a turn commits. */
export async function exportPortableCampaign(sessionId: string, ownerId: string) {
  requireUuid(sessionId);
  return db.transaction(async tx => {
    const [session] = await tx.select().from(gameSessions).where(and(eq(gameSessions.id, sessionId), eq(gameSessions.ownerId, ownerId)));
    if (!session) return null;
    return createPortableDocument(await readCampaignSnapshot(tx, session));
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Read one consistent campaign snapshot; exports retain the full journal without the prompt-size cap. */
export async function exportCampaignMarkdown(sessionId: string): Promise<string | null> {
  return db.transaction(async tx => {
    const [session] = await tx.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    if (!session) return null;
    const turns = await tx.select().from(gameTurns).where(and(eq(gameTurns.sessionId, sessionId), lte(gameTurns.turnNumber, session.turnCount)))
      .orderBy(asc(gameTurns.turnNumber), asc(sql`case when ${gameTurns.role} = 'player' then 0 else 1 end`), asc(gameTurns.createdAt));
    const agreements = await tx.select().from(agreementEvents).where(and(eq(agreementEvents.sessionId, sessionId), lte(agreementEvents.turnNumber, session.turnCount)))
      .orderBy(asc(agreementEvents.turnNumber), asc(agreementEvents.version));
    const story = `# ${session.title}\n\n${session.worldState.worldName} · ${session.rulesProfile}\n\nГерой: ${session.character.name} — ${session.character.archetype}\n\n`
      + turns.map(turn => `## Ход ${turn.turnNumber} · ${turn.role === "player" ? session.character.name : "Рассказчик"}\n\n${turn.content}${turn.dice ? `\n\nПроверка: ${turn.dice.label} · ${turn.dice.total} / ${turn.dice.dc}` : ""}`).join("\n\n---\n\n");
    // NARR-9: завершённая история остаётся читаемой — эпилог и итог формы истории входят в экспорт.
    const life = readLife(session.worldState);
    const finale = life.story.status === "resolved"
      ? `\n\n---\n\n## Эпилог\n\n${STORY_SHAPE_LABELS[life.story.kind].title} завершена на ходу ${life.story.resolvedTurn ?? session.turnCount} (${formatClock(life.clock)}).${life.story.goal ? ` Цель: ${life.story.goal}.` : ""}${life.story.epilogue ? `\n\n${life.story.epilogue}` : ""}`
      : "";
    if (!agreements.length) return story + finale;
    // Indented JSON preserves exact terms and provenance without allowing quoted fences to escape the block.
    return `${story}${finale}\n\n---\n\n## Журнал договорённостей\n\nКаждая запись — неизменяемая версия. proposed означает предложение, accepted — принятую договорённость, fulfilled — исполнение, cancelled — отмену.\n\n`
      + JSON.stringify(agreements, null, 2).split("\n").map(line => `    ${line}`).join("\n") + "\n";
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
