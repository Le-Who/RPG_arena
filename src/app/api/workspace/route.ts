import { db } from "@/db";
import { workspacePreferences } from "@/db/schema";
import { eq } from "drizzle-orm";
import { SCENARIOS } from "@/lib/scenarios";
export const dynamic = "force-dynamic";
async function get() {
  await db.insert(workspacePreferences).values({ id: "local" }).onConflictDoNothing();
  const [row] = await db.select().from(workspacePreferences).where(eq(workspacePreferences.id, "local"));
  return row;
}
export async function GET() { return Response.json(await get()); }
export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Некорректный запрос" }, { status: 400 });
  const current = await get();
  const favorites = Array.isArray(body.favorites) ? [...new Set(body.favorites.filter((id: unknown): id is string => typeof id === "string" && SCENARIOS.some((s) => s.id === id)))].slice(0, 50) as string[] : current.favorites;
  const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim().slice(0, 40) : current.displayName;
  const [updated] = await db.update(workspacePreferences).set({ favorites, displayName, updatedAt: new Date() }).where(eq(workspacePreferences.id, "local")).returning();
  return Response.json(updated);
}
