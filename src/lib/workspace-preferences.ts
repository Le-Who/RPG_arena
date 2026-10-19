import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workspacePreferences } from "@/db/schema";
import { normalizeReading } from "./reading-preferences";

/** Existing preferences are a read, not an INSERT on every navigation/refresh. */
export async function getWorkspacePreferences(id: string) {
  const [existing] = await db.select().from(workspacePreferences).where(eq(workspacePreferences.id, id));
  if (existing) return { ...existing, reading: normalizeReading(existing.reading) };
  const [created] = await db.insert(workspacePreferences).values({ id }).onConflictDoNothing().returning();
  const row = created ?? (await db.select().from(workspacePreferences).where(eq(workspacePreferences.id, id)))[0];
  if (!row) throw new Error("Workspace preferences were not created");
  return { ...row, reading: normalizeReading(row.reading) };
}
