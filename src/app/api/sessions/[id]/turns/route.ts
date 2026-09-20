import { withCampaignAccess } from "@/lib/campaign-access";
import { db } from "@/db";
import { gameTurns } from "@/db/schema";
import { and, desc, eq, lt, sql } from "drizzle-orm";
export const dynamic = "force-dynamic";
async function handleGET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const before = Number(new URL(req.url).searchParams.get("before"));
  if (!Number.isInteger(before) || before < 1) return Response.json({ error: "Некорректный номер хода" }, { status: 400 });
  const rows = await db.select().from(gameTurns).where(and(eq(gameTurns.sessionId, id), lt(gameTurns.turnNumber, before))).orderBy(desc(gameTurns.turnNumber), desc(sql`case when ${gameTurns.role} = 'player' then 0 else 1 end`), desc(gameTurns.createdAt)).limit(60);
  return Response.json({ turns: rows.reverse(), hasMore: rows.length === 60 });
}

export const GET = withCampaignAccess("read", handleGET);
