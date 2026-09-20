import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { agreementEvents, gameSessions, gameTurns } from "@/db/schema";

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
    if (!agreements.length) return story;
    // Indented JSON preserves exact terms and provenance without allowing quoted fences to escape the block.
    return `${story}\n\n---\n\n## Журнал договорённостей\n\nКаждая запись — неизменяемая версия. proposed означает предложение, accepted — принятую договорённость, fulfilled — исполнение, cancelled — отмену.\n\n`
      + JSON.stringify(agreements, null, 2).split("\n").map(line => `    ${line}`).join("\n") + "\n";
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
