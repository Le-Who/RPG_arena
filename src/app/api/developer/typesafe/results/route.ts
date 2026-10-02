import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions, memoryJobs } from "@/db/schema";
import { httpError } from "@/lib/http";
import { currentProfileId } from "@/lib/identity";
import { withAdminAccess } from "@/lib/admin-access";

export const dynamic = "force-dynamic";

async function handleGET() {
  try {
    const results = await db.select({
      id: memoryJobs.id,
      campaignTitle: gameSessions.title,
      turnNumber: memoryJobs.turnNumber,
      report: memoryJobs.typesafeReport,
      completedAt: memoryJobs.updatedAt,
    }).from(memoryJobs)
      .innerJoin(gameSessions, eq(memoryJobs.sessionId, gameSessions.id))
      .where(and(
        eq(gameSessions.ownerId, await currentProfileId()),
        eq(memoryJobs.status, "completed"),
        isNotNull(memoryJobs.typesafeReport),
        sql`jsonb_typeof(${memoryJobs.typesafeReport}) = 'object'`,
        sql`${memoryJobs.typesafeReport}->>'status' in ('no_key', 'empty', 'ok', 'error')`,
      ))
      .orderBy(desc(memoryJobs.updatedAt))
      .limit(20);
    return Response.json({ results });
  } catch (error) {
    return httpError(error);
  }
}
export const GET = withAdminAccess(handleGET);
