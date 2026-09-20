import { withCampaignAccess } from "@/lib/campaign-access";
import { db } from "@/db";
import { gameSessions, gameTurns } from "@/db/schema";
import { asc, eq, sql } from "drizzle-orm";
export const dynamic = "force-dynamic";
async function handleGET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, id));
  if (!session) return Response.json({ error: "История не найдена" }, { status: 404 });
  const turns = await db.select().from(gameTurns).where(eq(gameTurns.sessionId, id)).orderBy(asc(gameTurns.turnNumber), asc(sql`case when ${gameTurns.role} = 'player' then 0 else 1 end`), asc(gameTurns.createdAt));
  const text = `# ${session.title}\n\n${session.worldState.worldName} · ${session.rulesProfile}\n\nГерой: ${session.character.name} — ${session.character.archetype}\n\n` + turns.map((turn) => `## Ход ${turn.turnNumber} · ${turn.role === "player" ? session.character.name : "Рассказчик"}\n\n${turn.content}${turn.dice ? `\n\nПроверка: ${turn.dice.label} · ${turn.dice.total} / ${turn.dice.dc}` : ""}`).join("\n\n---\n\n");
  return new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="chronicle-${id.slice(0, 8)}.md"` } });
}

export const GET = withCampaignAccess("read", handleGET);
