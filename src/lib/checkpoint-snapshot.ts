import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "./http";
import { CHECKPOINT_MAX_BYTES, type CheckpointSnapshot } from "./checkpoint-types";
import { reduceAgreementProposals } from "./narrative-agreements";
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
  if (snapshot.agreements !== undefined && (!Array.isArray(snapshot.agreements) || snapshot.agreements.length > 1000)) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Снимок содержит некорректный журнал договорённостей.");
  const tables = [snapshot.turns, snapshot.inventory, snapshot.locations, snapshot.quests, snapshot.npcs, snapshot.sceneObjects, snapshot.memories];
  if (tables.some((rows) => rows.some((row) => row.sessionId !== source))) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "В снимке обнаружена сущность другой кампании.");
  const allIds = [...tables.flatMap((rows) => rows.map((row) => row.id)), ...(snapshot.agreements ?? []).map(row => row.id)];
  if (new Set(allIds).size !== allIds.length) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "В снимке повторяются идентификаторы.");
  const current = snapshot.locations.filter((location) => location.current);
  if (current.length !== 1 || current[0].name !== snapshot.session.worldState.currentLocation) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Текущая локация мира не согласована с картой.");
  if (snapshot.turns.some((t) => t.turnNumber > turn) || snapshot.memories.some((m) => (m.sourceTurn ?? 0) > turn || (m.turnTo ?? 0) > turn) || snapshot.quests.some((q) => q.updatedTurn > turn) || snapshot.npcs.some((n) => n.lastSeenTurn > turn) || snapshot.sceneObjects.some((o) => o.updatedTurn > turn)) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Снимок содержит события из будущего.");
  if (!snapshot.turns.some((t) => t.turnNumber === turn && t.role === "narrator")) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "В снимке нет завершённого последнего хода.");
  const memoryIds = new Set(snapshot.memories.map((m) => m.id));
  if (snapshot.links.some((link) => !memoryIds.has(link.fromId) || !memoryIds.has(link.toId))) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Связь памяти выходит за границы снимка.");
  const history: NonNullable<CheckpointSnapshot["agreements"]> = [];
  for (const revision of [...(snapshot.agreements ?? [])].sort((a, b) => a.turnNumber - b.turnNumber || a.version - b.version)) {
    const origin = snapshot.turns.find(t => t.id === revision.source?.originTurnId && t.role === "narrator" && t.turnNumber === revision.turnNumber);
    const ids = [revision.id, revision.agreementId, ...(revision.previousRevisionId ? [revision.previousRevisionId] : [])];
    if (revision.sessionId !== source || revision.turnNumber > turn || revision.rulesVersion !== 1
      || ids.some(id => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      || !origin || origin.content !== revision.source.quote || revision.source.turnNumber !== revision.turnNumber
      || revision.source.start !== 0 || revision.source.end !== origin.content.length
      || createHash("sha256").update(origin.content).digest("hex") !== revision.source.textSha256) {
      throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Источник договорённости не согласован со снимком кампании.");
    }
    const prior = history.filter(r => r.agreementId === revision.agreementId).at(-1);
    if ((!prior && (revision.previousRevisionId !== null || revision.version !== 1)) || (prior && (revision.previousRevisionId !== prior.id || revision.version !== prior.version + 1))) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Нарушена последовательность договорённостей в снимке.");
    const admitted = reduceAgreementProposals({ sessionId: source, turnNumber: revision.turnNumber, originTurnId: origin.id,
      currentNarration: origin.content, playerAction: "", history, proposals: [{ ...revision,
        agreementId: prior ? revision.agreementId : undefined, previousRevisionId: prior?.id, source: { kind: revision.source.kind } }] });
    if (admitted.rejected.length || admitted.accepted.length !== 1) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Условия договорённости в снимке некорректны.");
    history.push(revision);
  }
}
/** Remap identities in structured references, #short refs, entity keys and stored text. */
export function remapSnapshot(snapshot: CheckpointSnapshot, newSessionId = randomUUID(), makeId: () => string = randomUUID): CheckpointSnapshot {
  assertSnapshot(snapshot);
  const ids = new Map<string, string>([[snapshot.session.id, newSessionId]]);
  for (const rows of [snapshot.turns, snapshot.inventory, snapshot.locations, snapshot.quests, snapshot.npcs, snapshot.sceneObjects, snapshot.memories, snapshot.links]) for (const row of rows) ids.set(row.id, makeId());
  for (const revision of snapshot.agreements ?? []) {
    ids.set(revision.id, makeId());
    if (!ids.has(revision.agreementId)) ids.set(revision.agreementId, makeId());
  }
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
  // Historical source prose is immutable: remapping UUIDs inside it would invalidate its attestation.
  for (const revision of snapshot.agreements ?? []) {
    const copied = copy.agreements!.find(r => r.id === ids.get(revision.id))!;
    copied.source.quote = revision.source.quote;
    copied.source.textSha256 = revision.source.textSha256;
    const origin = copy.turns.find(t => t.id === copied.source.originTurnId)!;
    origin.content = revision.source.quote;
  }
  for (let index = 0; index < snapshot.turns.length; index++) {
    const original = snapshot.turns[index], remapped = copy.turns[index];
    const sourceVerification = original.contextMeta?.narrativeVerification;
    const copiedVerification = remapped.contextMeta?.narrativeVerification;
    if (!copiedVerification || !sourceVerification) continue;
    // Evidence and review citations attest to the original historical inputs. Preserve
    // their text, hashes, and verdicts; only their structured source row IDs are copied.
    const copiedSourceIds = copiedVerification.evidence.sources.map(source => source.id);
    copiedVerification.evidence = structuredClone(sourceVerification.evidence);
    copiedVerification.evidence.sources.forEach((source, sourceIndex) => { source.id = copiedSourceIds[sourceIndex]; });
    if (sourceVerification.reviews) copiedVerification.reviews = structuredClone(sourceVerification.reviews);
    if (!sourceVerification.textSha256) continue;
    const sourceHash = createHash("sha256").update(original.content).digest("hex");
    if (sourceVerification.version === 1 && sourceVerification.textSha256 === sourceHash) {
      copiedVerification.textSha256 = createHash("sha256").update(remapped.content).digest("hex");
    } else {
      delete copiedVerification.textSha256;
    }
  }
  const memoryIds = new Set(copy.memories.map((m) => m.id));
  copy.memories = copy.memories.map((memory) => ({ ...memory, parentId: memory.parentId && memoryIds.has(memory.parentId) ? memory.parentId : null }));
  const locationIds = new Set(copy.locations.map((l) => l.id));
  copy.locations = copy.locations.map((location) => ({ ...location, connectedTo: (location.connectedTo ?? []).filter((id) => locationIds.has(id)) }));
  for (const turn of copy.turns) if (turn.contextMeta) turn.contextMeta.retrievedIds = turn.contextMeta.retrievedIds.filter((id) => memoryIds.has(id));
  return copy;
}
