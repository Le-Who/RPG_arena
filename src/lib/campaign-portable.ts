import { createHash } from "node:crypto";
import type { CheckpointSnapshot } from "./checkpoint-types";
import { CHECKPOINT_MAX_BYTES } from "./checkpoint-types";
import { assertSnapshot, snapshotChecksum, stableSerialize } from "./checkpoint-snapshot";
import { HttpError } from "./http";

export const PORTABLE_MAX_BYTES = CHECKPOINT_MAX_BYTES;
type Rule = (value: unknown, path: string) => unknown;
const invalid = (path: string): never => { throw new HttpError(400, "INVALID_DOCUMENT", `Некорректное поле ${path}.`); };
const text = (max = 100_000): Rule => (v, p) => typeof v === "string" && v.length <= max ? v : invalid(p);
const nonempty = (max = 100_000): Rule => (v, p) => typeof v === "string" && !!v.trim() && v.length <= max ? v : invalid(p);
const integer = (min = 0, max = 1_000_000_000): Rule => (v, p) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : invalid(p);
const number = (min = -1_000_000_000, max = 1_000_000_000): Rule => (v, p) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : invalid(p);
const bool: Rule = (v, p) => typeof v === "boolean" ? v : invalid(p);
const uuid: Rule = (v, p) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : invalid(p);
const isoDate: Rule = (v, p) => {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)) return invalid(p);
  const timestamp = Date.parse(v);
  if (Number.isNaN(timestamp)) return invalid(p);
  const canonical = new Date(timestamp).toISOString();
  return canonical === v || canonical.replace(".000Z", "Z") === v ? v : invalid(p);
};
const choice = (...values: unknown[]): Rule => (v, p) => values.includes(v) ? v : invalid(p);
const nullable = (rule: Rule): Rule => (v, p) => v === null ? null : rule(v, p);
const optional = (rule: Rule): Rule => (v, p) => v === undefined ? undefined : rule(v, p);
const array = (rule: Rule, max = 1000): Rule => (v, p) => Array.isArray(v) && v.length <= max ? v.map((item, i) => rule(item, `${p}[${i}]`)) : invalid(p);
const object = (fields: Record<string, Rule>): Rule => (v, p) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return invalid(p);
  const input = v as Record<string, unknown>;
  if (Object.keys(input).some(key => !Object.hasOwn(fields, key))) return invalid(p);
  const output: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(fields)) {
    const parsed = rule(input[key], `${p}.${key}`);
    if (parsed !== undefined) output[key] = parsed;
  }
  return output;
};
const record = (rule: Rule, max = 100): Rule => (v, p) => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length > max) return invalid(p);
  return Object.fromEntries(Object.entries(v).map(([key, item]) => {
    if (!key || key.length > 100 || ["__proto__", "prototype", "constructor"].includes(key)) return invalid(p);
    return [key, rule(item, `${p}.${key}`)];
  }));
};
const flag: Rule = (v, p) => typeof v === "boolean" ? v : typeof v === "string" ? text(2000)(v, p) : number()(v, p);
// Bound work and cycles before checksum's recursive serializer sees untrusted input.
function preflight(value: unknown): void {
  const seen = new WeakSet<object>();
  let nodes = 0, bytes = 0;
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const { value: current, depth } = stack.pop()!;
    if (++nodes > 100_000 || depth > 20) invalid("document");
    if (typeof current === "string") bytes += Buffer.byteLength(current, "utf8");
    else if (typeof current === "number" && !Number.isFinite(current)) invalid("document");
    else if (current && typeof current === "object") {
      if (seen.has(current)) invalid("document");
      seen.add(current);
      if (Object.keys(current).length > 3000) invalid("document");
      for (const [key, child] of Object.entries(current)) {
        bytes += Buffer.byteLength(key, "utf8") + 8;
        stack.push({ value: child, depth: depth + 1 });
      }
    } else if (current !== null && typeof current !== "boolean" && typeof current !== "number") invalid("document");
    if (bytes > PORTABLE_MAX_BYTES) throw new HttpError(413, "DOCUMENT_TOO_LARGE", "Файл кампании превышает 4 МБ.");
  }
}

const strings = (max = 100, each = 2000) => array(text(each), max);
const character = object({
  name: nonempty(160), archetype: text(160), level: integer(), xp: integer(), hp: number(), maxHp: number(),
  gold: number(), stats: record(number(), 100), skills: strings(), traits: strings(), backstory: text(),
  appearance: text(), conditions: optional(strings()),
});
const world = object({
  worldName: nonempty(200), tone: text(2000), era: text(2000), mainQuest: text(10_000),
  currentLocation: nonempty(500), factions: strings(), flags: record(flag, 1000), danger: number(0, 100), chapter: integer(),
});
const session = object({
  id: uuid, title: nonempty(80), scenarioId: text(200), scenarioTitle: text(500), scenarioPrompt: text(),
  campaignMode: choice("free", "preset"), rulesProfile: choice("d20", "rules-light", "narrative"),
  character, worldState: world, status: choice("active", "paused", "finished", "archived"), turnCount: integer(1),
  contextTokensEstimate: integer(), lastCompactTurn: integer(),
});
const dice = object({
  goal: optional(text(2000)), d20: integer(0, 20), modifier: number(), total: number(), dc: number(), success: bool,
  critical: nullable(choice("crit", "fumble")), skill: text(500), label: text(1000),
  kind: optional(choice("d20", "2d6")), band: optional(choice("full", "cost", "fail")),
});
const stateChanges = object({
  hp: number(), xp: number(), gold: number(), danger: number(), levelUp: bool, dead: bool,
  location: nullable(object({ from: text(500), to: text(500), isNew: bool })),
  quests: array(object({ title: text(500), status: text(200), progress: number(), isNew: bool })),
  npcs: array(object({ name: text(500), relation: number(), delta: number(), status: text(200), isNew: bool })),
  inventory: array(object({ op: text(200), name: text(500), quantity: number(), ok: bool, reason: optional(text(2000)) })),
  sceneObjects: array(object({ name: text(500), state: text(500), isNew: bool })),
  conditions: object({ added: strings(), removed: strings() }), rejected: strings(1000, 10_000),
});
const verdict = choice("consistent", "contradicts", "insufficient");
const question = object({ type: choice("choice"), instructions: text(10_000), criteria: object({ consistent: text(5000), contradicts: text(5000), insufficient: text(5000) }) });
const selection = object({ required: bool, reasons: strings(), questions: record(question, 30) });
const reviewAnswer = object({
  id: text(200), verdict, reason: text(2000), reportedVerdict: optional(verdict),
  evidence: array(object({ path: text(500), quote: text(12_000) }), 12),
});
const review = object({ status: choice("verified", "rejected", "uncertain"), answers: array(reviewAnswer, 30) });
const verification = object({
  status: choice("verified", "rejected", "uncertain", "unavailable", "skipped"),
  provider: choice("typesafe", "openrouter"), model: text(300), latencyMs: number(0),
  reason: optional(text(1000)), answers: record(object({
    choice: verdict, confidence: number(0, 1), probabilities: object({ consistent: number(0, 1), contradicts: number(0, 1), insufficient: number(0, 1) }),
  }), 30),
  usage: optional(object({ inputTokens: integer(), outputTokens: integer(), cost: optional(number(0)) })),
});
const evidence = object({
  completeHistory: choice(false),
  truncated: bool,
  sources: array(object({
    id: uuid, turn: integer(1), role: choice("player", "narrator"), text: text(6000),
    sha256: text(64), truncated: bool,
    authority: choice("intention", "legacy_narration", "disputed_narration", "verified_narration"),
    acceptedChanges: nullable(stateChanges),
  }), 40),
});
const timings = object({
  admissionMs: optional(number(0)), contextMs: optional(number(0)), retrievalMs: optional(number(0)),
  retrievalDatabaseMs: optional(number(0)), retrievalEmbeddingMs: optional(number(0)),
  retrievalCandidates: optional(integer()), retrievalBackend: optional(choice("postgres", "legacy")),
  generationMs: optional(number(0)), verificationMs: optional(number(0)), validationMs: optional(number(0)),
  writesMs: optional(number(0)), serverMs: optional(number(0)), firstTextMs: optional(number(0)),
  attempts: optional(integer()), thoughtTokens: optional(integer()), cachedTokens: optional(integer()),
});
const contextMeta = object({
  model: text(300), rulesProfile: choice("d20", "rules-light", "narrative"), digestChars: integer(),
  retrievedIds: array(uuid, 1000), retrievalMs: optional(number(0)), skippedModels: optional(strings()),
  timings: optional(timings),
  narrativeVerification: optional(object({
    version: choice(1), reasons: strings(), repaired: bool, emittedCharacters: integer(),
    textSha256: optional(text(64)), checks: array(verification, 20), checkSelections: optional(array(selection, 20)),
    reviews: optional(array(object({ attempt: integer(), result: review, model: text(300), latencyMs: number(0) }), 20)),
    evidence,
  })),
});
const row = (fields: Record<string, Rule>) => object({ id: uuid, sessionId: uuid, ...fields });
const dated = { createdAt: isoDate };
const snapshotRule = object({
  schemaVersion: choice(1), session,
  turns: array(row({
    turnNumber: integer(1), role: choice("narrator", "player", "system", "dice", "memory"),
    content: text(), choices: nullable(strings()), dice: nullable(dice), modelUsed: nullable(text(300)),
    taskType: nullable(text(200)), promptTokens: nullable(integer()), completionTokens: nullable(integer()),
    requestId: nullable(choice()), stateChanges: nullable(stateChanges), contextMeta: nullable(contextMeta), ...dated,
  }), 2000),
  inventory: array(row({ name: nonempty(500), kind: text(200), description: text(), quantity: integer(), equipped: bool, power: integer(-1_000_000), icon: text(100), ...dated })),
  locations: array(row({ name: nonempty(500), description: text(), x: integer(-1_000_000), y: integer(-1_000_000), discovered: bool, current: bool, danger: integer(0, 100), icon: text(100), connectedTo: nullable(array(uuid)) })),
  quests: array(row({ key: nonempty(200), title: nonempty(500), description: text(), status: choice("active", "completed", "failed", "hidden"), progress: integer(0, 100), isMain: bool, updatedTurn: integer(), ...dated })),
  npcs: array(row({ key: nonempty(200), name: nonempty(500), role: text(500), description: text(), relation: integer(-100, 100), status: choice("alive", "dead", "missing", "unknown"), lastSeenTurn: integer(), lastLocation: text(500), ...dated })),
  sceneObjects: array(row({ key: nonempty(200), name: nonempty(500), locationName: text(500), state: text(500), description: text(), interactable: bool, updatedTurn: integer(), ...dated })),
  memories: array(row({
    layer: choice("episodic", "semantic", "procedural", "chronicle"), category: choice("character", "world", "event", "quest", "npc", "item", "rule", "location"),
    title: nonempty(1000), content: text(), importance: number(0, 100), salience: number(0, 100), tokensEstimate: integer(),
    parentId: nullable(uuid), turnFrom: nullable(integer()), turnTo: nullable(integer()), source: choice("seed", "state", "ai-semantic", "compaction", "heuristic"),
    sourceTurn: nullable(integer()), contentHash: nullable(text(128)), entityKey: nullable(text(2000)),
    confidence: number(0, 1), evidence: nullable(text()), createdAt: isoDate, updatedAt: isoDate,
  })),
  links: array(object({ id: uuid, fromId: uuid, toId: uuid, relation: text(500) })),
  agreements: optional(array(object({
    id: uuid, agreementId: uuid, sessionId: uuid, turnNumber: integer(1), version: integer(1),
    previousRevisionId: nullable(uuid), parties: array(nonempty(160), 6), object: nonempty(600),
    consideration: nonempty(800), conditions: array(nonempty(400), 6),
    status: choice("proposed", "accepted", "fulfilled", "cancelled"), rulesVersion: choice(1),
    source: object({ kind: choice("player_intent", "current_turn"), originTurnId: uuid, turnNumber: integer(1),
      quote: text(100_000), start: integer(), end: integer(), textSha256: text(64) }),
  }))),
});
const documentRule = object({
  format: choice("chronicle-campaign"), schemaVersion: choice(1),
  checksum: text(64), exportedAt: isoDate,
  engine: object({ campaignMode: choice("free", "preset"), rulesProfile: choice("d20", "rules-light", "narrative") }),
  title: nonempty(80), snapshot: snapshotRule,
});

export type PortableDocument = {
  format: "chronicle-campaign"; schemaVersion: 1; checksum: string; exportedAt: string;
  engine: { campaignMode: CheckpointSnapshot["session"]["campaignMode"]; rulesProfile: CheckpointSnapshot["session"]["rulesProfile"] };
  title: string; snapshot: CheckpointSnapshot;
};

export function parsePortableDocument(input: unknown): PortableDocument {
  preflight(input);
  const document = documentRule(input, "document") as PortableDocument;
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > PORTABLE_MAX_BYTES) throw new HttpError(413, "DOCUMENT_TOO_LARGE", "Файл кампании превышает 4 МБ.");
  if (document.engine.campaignMode !== document.snapshot.session.campaignMode || document.engine.rulesProfile !== document.snapshot.session.rulesProfile
    || document.title !== document.snapshot.session.title) invalid("document.engine");
  const source = document.snapshot.session.id;
  const ids = new Set(document.snapshot.memories.map(row => row.id));
  const locations = new Set(document.snapshot.locations.map(row => row.id));
  const allIds = [source, ...[document.snapshot.turns, document.snapshot.inventory, document.snapshot.locations,
    document.snapshot.quests, document.snapshot.npcs, document.snapshot.sceneObjects, document.snapshot.memories,
    document.snapshot.links, document.snapshot.agreements ?? []].flatMap(rows => rows.map(row => row.id))];
  if (new Set(allIds).size !== allIds.length) invalid("document.snapshot.ids");
  if (document.snapshot.memories.some(row => row.parentId && !ids.has(row.parentId))
    || document.snapshot.locations.some(row => row.connectedTo?.some(id => !locations.has(id)))
    || document.snapshot.turns.some(row => row.contextMeta?.retrievedIds.some(id => !ids.has(id)))
    || document.snapshot.session.lastCompactTurn > document.snapshot.session.turnCount
    || document.snapshot.links.some(row => !ids.has(row.fromId) || !ids.has(row.toId))) invalid("document.snapshot.references");
  // Structural validation must precede checksum recursion and SQL. Agreement provenance
  // is rechecked against the exact narration by the existing checkpoint validator.
  assertSnapshot(document.snapshot);
  if (snapshotChecksum(document.snapshot) !== document.checksum) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Контрольная сумма файла не совпадает.");
  return document;
}

export function createPortableDocument(snapshot: CheckpointSnapshot, exportedAt = new Date().toISOString()): PortableDocument {
  const normalized = { ...snapshot, turns: snapshot.turns.map(turn => ({ ...turn, requestId: null })) };
  const document = {
    format: "chronicle-campaign" as const, schemaVersion: 1 as const, exportedAt,
    engine: { campaignMode: normalized.session.campaignMode, rulesProfile: normalized.session.rulesProfile },
    title: normalized.session.title, snapshot: normalized, checksum: snapshotChecksum(normalized),
  };
  return parsePortableDocument(document);
}

/** Replay identity excludes the export timestamp, which is not campaign content. */
export function portableFingerprint(document: PortableDocument, title: string): string {
  return createHash("sha256").update(stableSerialize({ engine: document.engine, title: document.title, snapshot: document.snapshot, requestedTitle: title })).digest("hex");
}
