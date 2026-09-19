import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "./http";
import { CHECKPOINT_MAX_BYTES, type CheckpointSnapshot } from "./checkpoint-types";
export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function snapshotChecksum(value: CheckpointSnapshot): string { return createHash("sha256").update(stableSerialize(value)).digest("hex"); }
export function assertSnapshot(snapshot: CheckpointSnapshot) {
  if (snapshot.schemaVersion !== 1) throw new HttpError(409, "SNAPSHOT_VERSION", "Эта версия контрольной точки пока не поддерживается.");
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > CHECKPOINT_MAX_BYTES) throw new HttpError(413, "CHECKPOINT_TOO_LARGE", "Снимок больше 4 МБ. Экспортируйте журнал; для этой истории нужен расширенный формат хранения.");
  const source = snapshot.session.id, turn = snapshot.session.turnCount;
  const tables = [snapshot.turns, snapshot.inventory, snapshot.locations, snapshot.quests, snapshot.npcs, snapshot.sceneObjects, snapshot.memories];
  if (tables.some((rows) => rows.some((row) => row.sessionId !== source))) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "В снимке обнаружена сущность другой кампании.");
  const allIds = tables.flatMap((rows) => rows.map((row) => row.id));
  if (new Set(allIds).size !== allIds.length) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "В снимке повторяются идентификаторы.");
  const current = snapshot.locations.filter((location) => location.current);
  if (current.length !== 1 || current[0].name !== snapshot.session.worldState.currentLocation) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Текущая локация мира не согласована с картой.");
  if (snapshot.turns.some((t) => t.turnNumber > turn) || snapshot.memories.some((m) => (m.sourceTurn ?? 0) > turn || (m.turnTo ?? 0) > turn) || snapshot.quests.some((q) => q.updatedTurn > turn) || snapshot.npcs.some((n) => n.lastSeenTurn > turn) || snapshot.sceneObjects.some((o) => o.updatedTurn > turn)) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Снимок содержит события из будущего.");
  if (!snapshot.turns.some((t) => t.turnNumber === turn && t.role === "narrator")) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "В снимке нет завершённого последнего хода.");
  const memoryIds = new Set(snapshot.memories.map((m) => m.id));
  if (snapshot.links.some((link) => !memoryIds.has(link.fromId) || !memoryIds.has(link.toId))) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Связь памяти выходит за границы снимка.");
}
/** Remap identities in structured references, #short refs, entity keys and stored text. */
export function remapSnapshot(snapshot: CheckpointSnapshot, newSessionId = randomUUID(), makeId: () => string = randomUUID): CheckpointSnapshot {
  assertSnapshot(snapshot);
  const ids = new Map<string, string>([[snapshot.session.id, newSessionId]]);
  for (const rows of [snapshot.turns, snapshot.inventory, snapshot.locations, snapshot.quests, snapshot.npcs, snapshot.sceneObjects, snapshot.memories, snapshot.links]) for (const row of rows) ids.set(row.id, makeId());
  const short = new Map<string, string | null>();
  for (const [old, replacement] of ids) { const key = old.slice(0, 6); short.set(key, short.has(key) ? null : replacement.slice(0, 6)); }
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (match) => ids.get(match) ?? match).replace(/#([0-9a-f]{6})(?![0-9a-f])/gi, (match, key: string) => short.get(key) ? `#${short.get(key)}` : match);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, rewrite(v)]));
    return value;
  };
  const copy = rewrite(snapshot) as CheckpointSnapshot;
  copy.session.status = "active";
  copy.turns = copy.turns.map((turn) => ({ ...turn, requestId: null }));
  const memoryIds = new Set(copy.memories.map((m) => m.id));
  copy.memories = copy.memories.map((memory) => ({ ...memory, parentId: memory.parentId && memoryIds.has(memory.parentId) ? memory.parentId : null }));
  const locationIds = new Set(copy.locations.map((l) => l.id));
  copy.locations = copy.locations.map((location) => ({ ...location, connectedTo: (location.connectedTo ?? []).filter((id) => locationIds.has(id)) }));
  for (const turn of copy.turns) if (turn.contextMeta) turn.contextMeta.retrievedIds = turn.contextMeta.retrievedIds.filter((id) => memoryIds.has(id));
  return copy;
}
