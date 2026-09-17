import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    const tableCheck = await db.execute(sql`SELECT to_regclass('public.ai_settings') AS settings, to_regclass('public.memory_embeddings') AS embeddings`);
    const row = tableCheck.rows[0] as { settings: string | null; embeddings: string | null };
    return Response.json({ ok: true, migrationsApplied: row?.settings != null && row?.embeddings != null });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
