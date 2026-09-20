import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { worldLocations } from "@/db/schema";
import type { DbOp } from "./resolution";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type LocationDbOp = Extract<DbOp, { t: `loc.${string}` }>;

/** Execute one session-scoped map mutation. Connections are stored symmetrically. */
export async function executeLocationOp(tx: Tx, sessionId: string, op: LocationDbOp): Promise<void> {
  switch (op.t) {
    case "loc.insert":
      if (op.row.current) await tx.update(worldLocations).set({ current: false }).where(eq(worldLocations.sessionId, sessionId));
      await tx.insert(worldLocations).values({ sessionId, connectedTo: [], ...op.row });
      return;
    case "loc.setCurrent":
      await tx.update(worldLocations).set({ current: false }).where(eq(worldLocations.sessionId, sessionId));
      await tx.update(worldLocations).set({ current: true, discovered: true }).where(and(eq(worldLocations.id, op.id), eq(worldLocations.sessionId, sessionId)));
      return;
    case "loc.discover":
      await tx.update(worldLocations).set({ discovered: true }).where(and(eq(worldLocations.id, op.id), eq(worldLocations.sessionId, sessionId)));
      return;
    case "loc.connect": {
      if (op.fromId === op.toId) return;
      const rows = await tx.select({ id: worldLocations.id, connectedTo: worldLocations.connectedTo })
        .from(worldLocations)
        .where(and(eq(worldLocations.sessionId, sessionId), inArray(worldLocations.id, [op.fromId, op.toId])));
      if (rows.length !== 2) return;
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const [id, peerId] of [[op.fromId, op.toId], [op.toId, op.fromId]] as const) {
        const row = byId.get(id);
        if (!row) return;
        const connectedTo = [...new Set([...(row.connectedTo ?? []), peerId])];
        await tx.update(worldLocations).set({ connectedTo }).where(and(eq(worldLocations.id, id), eq(worldLocations.sessionId, sessionId)));
      }
    }
  }
}
