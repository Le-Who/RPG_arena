import { readJsonObject, httpError } from "@/lib/http";
import { db } from "@/db";
import { workspacePreferences } from "@/db/schema";
import { eq } from "drizzle-orm";
import { SCENARIOS } from "@/lib/scenarios";
import { normalizeReading } from "@/lib/reading-preferences";
export const dynamic = "force-dynamic";
async function get() {
  await db.insert(workspacePreferences).values({ id: "local" }).onConflictDoNothing();
  const [row] = await db.select().from(workspacePreferences).where(eq(workspacePreferences.id, "local"));
  // Rows written before v2.5 have no reading column value yet.
  return { ...row, reading: normalizeReading(row.reading) };
}
export async function GET() { return Response.json(await get()); }
export async function PATCH(req: Request) {
  try {
  const body = await readJsonObject(req, 8192);
  if (!body || typeof body !== "object") return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  const current = await get();
  const favorites = Array.isArray(body.favorites) ? [...new Set(body.favorites.filter((id: unknown): id is string => typeof id === "string" && SCENARIOS.some((s) => s.id === id)))].slice(0, 50) as string[] : current.favorites;
  const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim().slice(0, 40) : current.displayName;
  const reading = body.reading === undefined ? current.reading : normalizeReading(body.reading);
  const [updated] = await db.update(workspacePreferences).set({ favorites, displayName, reading, updatedAt: new Date() }).where(eq(workspacePreferences.id, "local")).returning();
  return Response.json({ ...updated, reading: normalizeReading(updated.reading) });
  } catch (error) { return httpError(error); }
}
