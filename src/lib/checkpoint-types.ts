import type { gameSessions, gameTurns, inventoryItems, worldLocations, quests, npcs, sceneObjects, memoryNodes, memoryLinks, campaignCheckpoints } from "@/db/schema";
type Plain<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
export type CheckpointSnapshot = {
  schemaVersion: 1;
  session: Omit<Plain<typeof gameSessions.$inferSelect>, "createdAt" | "updatedAt" | "branchOrigin" | "ownerId" | "visibility">;
  turns: Plain<typeof gameTurns.$inferSelect>[];
  inventory: Plain<typeof inventoryItems.$inferSelect>[];
  locations: Plain<typeof worldLocations.$inferSelect>[];
  quests: Plain<typeof quests.$inferSelect>[];
  npcs: Plain<typeof npcs.$inferSelect>[];
  sceneObjects: Plain<typeof sceneObjects.$inferSelect>[];
  memories: Plain<typeof memoryNodes.$inferSelect>[];
  links: Plain<typeof memoryLinks.$inferSelect>[];
};
export type CheckpointSummary = Omit<typeof campaignCheckpoints.$inferSelect, "snapshot" | "checksum" | "requestId" | "createdAt"> & { createdAt: string; branches: { id: string; title: string; turnCount: number }[] };
export const CHECKPOINT_LIMIT = 12;
export const CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024;
