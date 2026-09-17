import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    // Verify that migrations have been applied by checking a key table exists
    const tableCheck = await db.execute(
      sql`SELECT to_regclass('public.ai_settings') AS exists`,
    );
    const tableExists = (tableCheck.rows[0] as { exists: string | null })?.exists != null;
    return Response.json({ ok: true, migrationsApplied: tableExists });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
