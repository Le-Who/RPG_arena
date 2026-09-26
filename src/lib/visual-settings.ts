import { db } from "@/db";
import { visualSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { visualConfig } from "./visual-provider";

/** The server environment supplies a fallback; an administrator's saved choice wins. */
export async function readVisualConfig() {
  const base = visualConfig();
  const [saved] = await db.select({ model: visualSettings.model }).from(visualSettings).where(eq(visualSettings.id, 1)).limit(1);
  return { ...base, model: saved?.model ?? base.model };
}

export async function saveVisualModel(model: string, adminAccountId: string): Promise<void> {
  await db.insert(visualSettings).values({ id: 1, model, updatedBy: adminAccountId })
    .onConflictDoUpdate({ target: visualSettings.id, set: { model, updatedBy: adminAccountId, updatedAt: new Date() } });
}
