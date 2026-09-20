import { resolveInventoryReference } from "./entity-identity";
import { randomUUID } from "node:crypto";
// ── RES-1: контракт resolution, runtime-валидация и серверные reducers ──
// Модель предлагает художественную интерпретацию + структурированные изменения мира.
// Сервер валидирует (parseResolution), затем применяет (applyResolution) с лимитами профиля.
// Reducers — чистые функции: возвращают новое состояние, список DB-операций и канонические
// события памяти (source = "state"); транзакцию выполняет вызывающий код.

import type {
  AppliedChanges,
  CampaignMode,
  CharacterState,
  DiceResult,
  NpcStatus,
  QuestStatus,
  WorldState,
} from "@/db/schema";
import { profileFor, type ProfileSpec } from "./profiles";

// ─────────────────────────────────────────────────────────────
//  Типы контракта
// ─────────────────────────────────────────────────────────────
export type ResolutionOutcome = "success" | "partial" | "failure" | "neutral";

export type InventoryOp = {
  op: "add" | "consume" | "remove" | "equip" | "unequip";
  ref: string | null;
  name: string;
  kind: string;
  quantity: number;
  description: string;
};
export type QuestChange = { ref: string | null; title: string; status: QuestStatus | null; progress: number | null; note: string };
export type NpcChange = { ref: string | null; name: string; role: string; relationDelta: number; status: NpcStatus | null; note: string };
export type SceneObjectChange = { ref: string | null; name: string; state: string; note: string };
export type LocationChange = { action: "move" | "discover"; ref: string | null; name: string; description: string; danger: number | null } | null;
export type LocationDiscovery = { ref: string | null; name: string; description: string; danger: number | null };
export type LocationRoute = { from: string; to: string };

export type ResolutionPayload = {
  narration: string;
  outcome: ResolutionOutcome;
  choices: string[];
  effects: { hp: number; xp: number; gold: number; danger: number };
  stateChanges: {
    location: LocationChange;
    locations: LocationDiscovery[];
    routes: LocationRoute[];
    quests: QuestChange[];
    npcs: NpcChange[];
    inventory: InventoryOp[];
    sceneObjects: SceneObjectChange[];
    conditions: { add: string[]; remove: string[] };
    flags: Record<string, string | number | boolean>;
  };
};

/** JSON Schema (подмножество OpenAPI, поддерживаемое Gemini responseSchema). */
export const RESOLUTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    narration: { type: "string", description: "120–220 слов художественного текста на русском, второе лицо" },
    outcome: { type: "string", enum: ["success", "partial", "failure", "neutral"] },
    choices: { type: "array", items: { type: "string" }, description: "Ровно 3 коротких варианта следующего действия" },
    effects: {
      type: "object",
      properties: {
        hp: { type: "integer", description: "Изменение здоровья/состояния, отрицательное — урон" },
        xp: { type: "integer" },
        gold: { type: "integer" },
        danger: { type: "integer", description: "Изменение накала сцены −12…+12" },
      },
      required: ["hp", "xp", "gold", "danger"],
    },
    stateChanges: {
      type: "object",
      properties: {
        location: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["none", "move", "discover"] },
            ref: { type: "string", description: "ID или уникальное имя известной локации; пусто для новой" },
            name: { type: "string" },
            description: { type: "string" },
            danger: { type: "integer" },
          },
          required: ["action", "name"],
        },
        locations: {
          type: "array",
          description: "Все локации, явно открытые за этот ход; ref — ID или уникальное имя уже известной локации, пустой для новой",
          items: { type: "object", properties: {
            ref: { type: "string" }, name: { type: "string" }, description: { type: "string" }, danger: { type: "integer" },
          }, required: ["ref", "name"] },
        },
        routes: {
          type: "array",
          description: "Только явно установленные двусторонние пути; концы — ID или уникальные имена",
          items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
        },
        quests: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "key существующего квеста или пустая строка для нового" },
              title: { type: "string" },
              status: { type: "string", enum: ["active", "completed", "failed", "hidden", "unchanged"] },
              progress: { type: "integer", description: "0–100 или -1 если без изменений" },
              note: { type: "string" },
            },
            required: ["ref", "title", "status", "progress"],
          },
        },
        npcs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "key существующего NPC или пустая строка" },
              name: { type: "string" },
              role: { type: "string" },
              relationDelta: { type: "integer", description: "−30…+30" },
              status: { type: "string", enum: ["alive", "dead", "missing", "unknown", "unchanged"] },
              note: { type: "string" },
            },
            required: ["ref", "name", "relationDelta", "status"],
          },
        },
        inventory: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "consume", "remove", "equip", "unequip"] },
              ref: { type: "string", description: "#id предмета из списка инвентаря или пустая строка для нового" },
              name: { type: "string" },
              kind: { type: "string" },
              quantity: { type: "integer" },
              description: { type: "string" },
            },
            required: ["op", "ref", "name", "quantity"],
          },
        },
        sceneObjects: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              name: { type: "string" },
              state: { type: "string", description: "короткое состояние: открыт, сломан, спрятан…" },
              note: { type: "string" },
            },
            required: ["ref", "name", "state"],
          },
        },
        conditions: {
          type: "object",
          properties: {
            add: { type: "array", items: { type: "string" } },
            remove: { type: "array", items: { type: "string" } },
          },
          required: ["add", "remove"],
        },
        flags: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
          },
        },
      },
      required: ["location", "quests", "npcs", "inventory", "sceneObjects", "conditions", "flags"],
    },
  },
  required: ["narration", "outcome", "choices", "effects", "stateChanges"],
};

// ─────────────────────────────────────────────────────────────
//  Утилиты
// ─────────────────────────────────────────────────────────────
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "x";
}

const clampInt = (v: unknown, lo: number, hi: number, dflt = 0) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};
const str = (v: unknown, max: number, dflt = "") => (typeof v === "string" ? v.trim().slice(0, max) : dflt);
const arr = <T,>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : []);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const QUEST_STATUSES: QuestStatus[] = ["active", "completed", "failed", "hidden"];
const NPC_STATUSES: NpcStatus[] = ["alive", "dead", "missing", "unknown"];

export function parseChoicesFromText(text: string): string[] {
  const m = text.match(/ВАРИАНТЫ:\s*([\s\S]+)/i);
  if (!m) return [];
  const raw = m[1].trim();
  const parts = raw.includes("|")
    ? raw.split(/\s*\|\s*/)
    : raw.split(/(?=\s*\d+[).]\s)/);
  return parts.map((s) => s.replace(/^\s*\d+[).]\s*/, "").trim()).filter(Boolean).slice(0, 3);
}
export function stripChoicesLine(text: string) {
  return text.replace(/ВАРИАНТЫ:\s*[\s\S]+$/i, "").trim();
}

export function extractJsonObject(text: string): unknown | null {
  let t = text.trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!t.startsWith("{")) {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a === -1 || b <= a) return null;
    t = t.slice(a, b + 1);
  }
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  Runtime-валидация (RES-1b): любой JSON → нормализованный payload
// ─────────────────────────────────────────────────────────────
export function parseResolution(raw: string): { payload: ResolutionPayload; parsedJson: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const j = extractJsonObject(raw) as Record<string, unknown> | null;

  if (!j || typeof j !== "object") {
    // Текстовый фолбэк (модель ответила прозой): нарратив + ВАРИАНТЫ
    return {
      parsedJson: false,
      warnings: ["NO_JSON: текстовый фолбэк"],
      payload: {
        narration: (stripChoicesLine(raw) || raw).slice(0, 3000),
        outcome: "neutral",
        choices: parseChoicesFromText(raw),
        effects: { hp: 0, xp: 0, gold: 0, danger: 0 },
        stateChanges: emptyChanges(),
      },
    };
  }

  const sc = (j.stateChanges ?? {}) as Record<string, unknown>;
  const eff = (j.effects ?? {}) as Record<string, unknown>;
  const outcome = (["success", "partial", "failure", "neutral"] as const).includes(j.outcome as ResolutionOutcome)
    ? (j.outcome as ResolutionOutcome)
    : "neutral";

  const locRaw = (sc.location ?? null) as Record<string, unknown> | null;
  let location: LocationChange = null;
  if (locRaw && (locRaw.action === "move" || locRaw.action === "discover") && str(locRaw.name, 80)) {
    location = {
      action: locRaw.action,
      ref: str(locRaw.ref, 80) || null,
      name: str(locRaw.name, 80),
      description: str(locRaw.description, 240),
      danger: locRaw.danger == null ? null : clampInt(locRaw.danger, 0, 100),
    };
  }

  const locations: LocationDiscovery[] = arr<unknown>(sc.locations, 8)
    .filter(isRecord)
    .map((location) => ({
      ref: str(location.ref, 80) || null,
      name: str(location.name, 80),
      description: str(location.description, 240),
      danger: location.danger == null ? null : clampInt(location.danger, 0, 100),
    }))
    .filter((location) => location.ref || location.name);
  const routes: LocationRoute[] = arr<unknown>(sc.routes, 12)
    .filter(isRecord)
    .map((route) => ({ from: str(route.from, 80), to: str(route.to, 80) }))
    .filter((route) => route.from && route.to);

  const quests: QuestChange[] = arr<Record<string, unknown>>(sc.quests, 4)
    .map((q) => ({
      ref: str(q.ref, 64) || null,
      title: str(q.title, 120),
      status: QUEST_STATUSES.includes(q.status as QuestStatus) ? (q.status as QuestStatus) : null,
      progress: q.progress == null || Number(q.progress) < 0 ? null : clampInt(q.progress, 0, 100),
      note: str(q.note, 300),
    }))
    .filter((q) => q.title || q.ref);

  const npcs: NpcChange[] = arr<Record<string, unknown>>(sc.npcs, 5)
    .map((n) => ({
      ref: str(n.ref, 64) || null,
      name: str(n.name, 80),
      role: str(n.role, 80),
      relationDelta: clampInt(n.relationDelta, -100, 100),
      status: NPC_STATUSES.includes(n.status as NpcStatus) ? (n.status as NpcStatus) : null,
      note: str(n.note, 300),
    }))
    .filter((n) => n.name || n.ref);

  const inventory: InventoryOp[] = arr<Record<string, unknown>>(sc.inventory, 6)
    .map((i) => ({
      op: (["add", "consume", "remove", "equip", "unequip"] as const).includes(i.op as InventoryOp["op"]) ? (i.op as InventoryOp["op"]) : "add",
      ref: str(i.ref, 64).replace(/^#/, "") || null,
      name: str(i.name, 80),
      kind: str(i.kind, 20, "misc") || "misc",
      quantity: clampInt(i.quantity, 1, 20, 1),
      description: str(i.description, 300),
    }))
    .filter((i) => i.name || i.ref);

  const sceneObjects: SceneObjectChange[] = arr<Record<string, unknown>>(sc.sceneObjects, 4)
    .map((o) => ({ ref: str(o.ref, 64) || null, name: str(o.name, 80), state: str(o.state, 60, "intact") || "intact", note: str(o.note, 240) }))
    .filter((o) => o.name || o.ref);

  const condRaw = (sc.conditions ?? {}) as Record<string, unknown>;
  const conditions = {
    add: arr<unknown>(condRaw.add, 4).map((c) => str(c, 40)).filter(Boolean),
    remove: arr<unknown>(condRaw.remove, 4).map((c) => str(c, 40)).filter(Boolean),
  };

  const flags: Record<string, string | number | boolean> = {};
  if (Array.isArray(sc.flags)) {
    for (const f of sc.flags.slice(0, 8) as Record<string, unknown>[]) {
      const k = str(f?.key, 40);
      if (k) flags[k] = str(f?.value, 80) || true;
    }
  } else if (sc.flags && typeof sc.flags === "object") {
    for (const [k, v] of Object.entries(sc.flags as Record<string, unknown>).slice(0, 8)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") flags[k.slice(0, 40)] = v;
    }
  }

  let choices = arr<unknown>(j.choices, 3).map((c) => str(c, 160)).filter(Boolean);
  const narration = str(j.narration, 3000) || stripChoicesLine(raw).slice(0, 3000);
  if (!choices.length) {
    choices = parseChoicesFromText(raw);
    if (!choices.length) warnings.push("NO_CHOICES");
  }

  return {
    parsedJson: true,
    warnings,
    payload: {
      narration,
      outcome,
      choices,
      effects: {
        hp: clampInt(eff.hp, -100, 100),
        xp: clampInt(eff.xp, -100, 200),
        gold: clampInt(eff.gold, -1000, 1000),
        danger: clampInt(eff.danger, -30, 30),
      },
      stateChanges: { location, locations, routes, quests, npcs, inventory, sceneObjects, conditions, flags },
    },
  };
}

export function emptyChanges(): ResolutionPayload["stateChanges"] {
  return { location: null, locations: [], routes: [], quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { add: [], remove: [] }, flags: {} };
}

// ─────────────────────────────────────────────────────────────
//  Reducers (RES-1d/e/g, INV-1d): состояние → новое состояние + DB-операции + события памяти
// ─────────────────────────────────────────────────────────────
export type InvRow = { id: string; name: string; kind: string; quantity: number; equipped: boolean; description: string; icon: string; power: number };
export type QuestRow = { id: string; key: string; title: string; status: QuestStatus; progress: number; isMain: boolean; description: string };
export type NpcRow = { id: string; key: string; name: string; role: string; relation: number; status: NpcStatus; description: string };
export type SceneRow = { id: string; key: string; name: string; state: string; locationName: string; description: string };
export type LocRow = { id: string; name: string; x: number; y: number; current: boolean; discovered: boolean; danger: number; connectedTo?: string[] | null };

export type DbOp =
  | { t: "inv.insert"; row: { name: string; kind: string; description: string; quantity: number; icon: string } }
  | { t: "inv.update"; id: string; patch: { quantity?: number; equipped?: boolean } }
  | { t: "inv.delete"; id: string }
  | { t: "quest.insert"; row: { key: string; title: string; description: string; status: QuestStatus; progress: number; isMain: boolean } }
  | { t: "quest.update"; id: string; patch: { status?: QuestStatus; progress?: number; description?: string } }
  | { t: "npc.insert"; row: { key: string; name: string; role: string; description: string; relation: number; status: NpcStatus; lastLocation: string } }
  | { t: "npc.update"; id: string; patch: { relation?: number; status?: NpcStatus; role?: string; description?: string; lastLocation: string } }
  | { t: "scene.insert"; row: { key: string; name: string; state: string; description: string; locationName: string } }
  | { t: "scene.update"; id: string; patch: { state: string; description?: string } }
  | { t: "loc.insert"; row: { id: string; name: string; description: string; x: number; y: number; danger: number; current: boolean; discovered: boolean; icon: string } }
  | { t: "loc.setCurrent"; id: string }
  | { t: "loc.discover"; id: string }
  | { t: "loc.connect"; fromId: string; toId: string };

export type MemoryEvent = {
  layer: "episodic" | "semantic" | "procedural" | "chronicle";
  category: string;
  title: string;
  content: string;
  importance: number;
  entityKey: string; // канонический ключ для дедупликации/обновления (MEM-1e)
  mode: "upsert" | "append"; // upsert — обновить факт о сущности; append — отдельное событие
};

export type ApplyInput = {
  rulesProfile: string;
  campaignMode: CampaignMode;
  character: CharacterState;
  world: WorldState;
  inventory: InvRow[];
  quests: QuestRow[];
  npcs: NpcRow[];
  sceneObjects: SceneRow[];
  locations: LocRow[];
  payload: ResolutionPayload;
  dice: DiceResult | null;
  turnNumber: number;
  rng?: () => number;
  makeLocationId?: () => string;
};

export type ApplyResult = {
  character: CharacterState;
  world: WorldState;
  applied: AppliedChanges;
  ops: DbOp[];
  events: MemoryEvent[];
  outcome: ResolutionOutcome;
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[«»"']/g, "");

export function applyResolution(input: ApplyInput): ApplyResult {
  const spec: ProfileSpec = profileFor(input.rulesProfile);
  const { payload, dice, turnNumber } = input;
  const rng = input.rng ?? Math.random;
  const makeLocationId = input.makeLocationId ?? randomUUID;
  const ops: DbOp[] = [];
  const events: MemoryEvent[] = [];
  const rejected: string[] = [];
  const character: CharacterState = { ...input.character, conditions: [...(input.character.conditions ?? [])] };
  const world: WorldState = { ...input.world, flags: { ...(input.world.flags ?? {}) } };

  // ── RES-1e: сервер — источник истины для исхода при наличии проверки ──
  let outcome: ResolutionOutcome = payload.outcome;
  if (dice) {
    outcome = dice.band === "fail" || !dice.success ? "failure" : dice.band === "cost" ? "partial" : "success";
  }

  // ── Числовые эффекты по профилю (RES-1d) ──
  let hp = spec.resources.hp ? clampInt(payload.effects.hp, -spec.limits.hp, spec.limits.hp) : 0;
  let xp = spec.resources.xp ? clampInt(payload.effects.xp, 0, spec.limits.xp) : 0;
  let gold = spec.resources.gold ? clampInt(payload.effects.gold, -spec.limits.gold, spec.limits.gold) : 0;
  let danger = clampInt(payload.effects.danger, -spec.limits.danger, spec.limits.danger);

  if (dice) {
    if (outcome === "failure") {
      if (hp > 0) hp = 0; // провал не лечит
      if (gold > 0) gold = 0;
      if (spec.resources.xp) xp = Math.min(xp, 10);
      if (dice.critical === "fumble" && spec.resources.hp && hp > -2) hp = -2;
      if (danger === 0) danger = 4;
    } else if (outcome === "success") {
      if (hp < -Math.floor(spec.limits.hp / 3)) hp = -Math.floor(spec.limits.hp / 3); // успех не должен калечить
      if (dice.critical === "crit" && spec.resources.xp) xp = Math.min(spec.limits.xp, xp + 15);
      if (danger === 0) danger = -2;
    } else if (outcome === "partial" && danger === 0) {
      danger = 1;
    }
  }
  if (spec.resources.xp && xp === 0 && outcome !== "failure" && !payload.effects.xp) xp = 10; // базовый прогресс

  // ── HP / смерть / уровень ──
  let dead = false;
  let levelUp = false;
  if (spec.resources.hp) {
    const nextHp = Math.max(0, Math.min(character.maxHp, character.hp + hp));
    dead = nextHp <= 0 && hp < 0;
    character.hp = dead ? 1 : nextHp;
  }
  if (spec.resources.xp) {
    character.xp = Math.max(0, character.xp + xp);
    const nextLevel = 1 + Math.floor(character.xp / 120);
    if (nextLevel > character.level) {
      levelUp = true;
      character.level = nextLevel;
      character.maxHp += 5;
      character.hp = Math.min(character.maxHp, character.hp + 5);
    }
  }
  if (spec.resources.gold) {
    character.gold = Math.max(0, character.gold + gold);
    if (dead) character.gold = Math.max(0, character.gold - 10);
  }
  world.danger = Math.max(0, Math.min(100, world.danger + danger));

  // ── Состояния героя ──
  const addedConds: string[] = [];
  const removedConds: string[] = [];
  if (spec.resources.conditions) {
    for (const c of payload.stateChanges.conditions.remove) {
      const idx = character.conditions!.findIndex((x) => norm(x) === norm(c));
      if (idx >= 0) {
        removedConds.push(character.conditions![idx]);
        character.conditions!.splice(idx, 1);
      }
    }
    for (const c of payload.stateChanges.conditions.add) {
      if (character.conditions!.length >= 6) break;
      if (!character.conditions!.some((x) => norm(x) === norm(c))) {
        character.conditions!.push(c);
        addedConds.push(c);
      }
    }
    if (dead && !character.conditions!.some((x) => norm(x) === "на грани")) {
      character.conditions!.push("на грани");
      addedConds.push("на грани");
    }
  }

  // ── Флаги ──
  for (const [k, v] of Object.entries(payload.stateChanges.flags)) world.flags[k] = v;

  // ── Локации и граф: все ссылки разрешаются только по ID или уникальному имени ──
  let locationApplied: AppliedChanges["location"] = null;
  const lc = payload.stateChanges.location;
  const workingLocations: LocRow[] = input.locations.map((location) => ({ ...location, connectedTo: [...(location.connectedTo ?? [])] }));
  const occupied = new Set(workingLocations.map((location) => `${location.x},${location.y}`));
  const nextPosition = () => {
    const current = workingLocations.find((location) => location.current);
    const cx = current?.x ?? 6, cy = current?.y ?? 5;
    const offsets = [[2, 0], [0, 2], [-2, 0], [0, -2], [2, 2], [-2, 2], [-2, -2], [2, -2], [3, 1], [-3, 1], [1, 3], [1, -3]];
    for (const [dx, dy] of offsets) {
      const x = Math.max(1, Math.min(11, cx + dx)), y = Math.max(1, Math.min(9, cy + dy));
      if (!occupied.has(`${x},${y}`)) { occupied.add(`${x},${y}`); return { x, y }; }
    }
    for (let y = 1; y <= 9; y++) for (let x = 1; x <= 11; x++) {
      if (!occupied.has(`${x},${y}`)) { occupied.add(`${x},${y}`); return { x, y }; }
    }
    return { x: cx, y: cy };
  };
  const resolveLocation = (ref: string): { location?: LocRow; error?: string } => {
    const idMatch = workingLocations.find((location) => location.id === ref);
    if (idMatch) return { location: idMatch };
    const nameMatches = workingLocations.filter((location) => norm(location.name) === norm(ref));
    if (nameMatches.length === 1) return { location: nameMatches[0] };
    return { error: nameMatches.length > 1 ? `неоднозначное имя «${ref}»` : `неизвестная ссылка «${ref}»` };
  };
  const addLocation = (change: LocationDiscovery, current = false): LocRow | null => {
    const recordDiscovery = (location: LocRow) => {
      events.push({
        layer: "semantic", category: "location", title: `Локация: ${location.name}`,
        content: `${location.name}: ${change.description || "известна по слухам"}. Стала известна на ходу ${turnNumber}.`,
        importance: 58, entityKey: `location:${slugify(location.name)}`, mode: "upsert",
      });
    };
    if (change.ref) {
      const resolved = resolveLocation(change.ref);
      if (!resolved.location) { rejected.push(`Локация отклонена: ${resolved.error}`); return null; }
      if (!resolved.location.discovered) {
        resolved.location.discovered = true;
        ops.push({ t: "loc.discover", id: resolved.location.id });
        recordDiscovery(resolved.location);
      }
      return resolved.location;
    }
    const sameName = workingLocations.filter((location) => norm(location.name) === norm(change.name));
    if (sameName.length > 1) { rejected.push(`Локация отклонена: неоднозначное имя «${change.name}»`); return null; }
    if (sameName.length === 1) {
      if (!sameName[0].discovered) {
        sameName[0].discovered = true;
        ops.push({ t: "loc.discover", id: sameName[0].id });
        recordDiscovery(sameName[0]);
      }
      return sameName[0];
    }
    if (!change.name) return null;
    const id = makeLocationId();
    const { x, y } = nextPosition();
    const row = { id, name: change.name, description: change.description || "Упомянуто в истории", x, y, danger: change.danger ?? world.danger, current, discovered: true, icon: "📍" };
    ops.push({ t: "loc.insert", row });
    const created: LocRow = { ...row, connectedTo: [] };
    workingLocations.push(created);
    events.push({ layer: "semantic", category: "location", title: `Локация: ${change.name}`, content: `${change.name}: ${change.description || "известна по слухам"}. Стала известна на ходу ${turnNumber}.`, importance: 58, entityKey: `location:${slugify(change.name)}`, mode: "upsert" });
    return created;
  };

  for (const discovery of payload.stateChanges.locations) addLocation(discovery);
  if (lc?.action === "discover") addLocation({ ref: lc.ref, name: lc.name, description: lc.description, danger: lc.danger });

  const currentLocationRow = workingLocations.find((location) => location.current);
  const referencedMoveTarget = lc?.ref ? resolveLocation(lc.ref).location : undefined;
  const movementTargetsCurrent = lc?.ref
    ? referencedMoveTarget?.id === currentLocationRow?.id
    : Boolean(lc && norm(lc.name) === norm(world.currentLocation));
  if (lc && lc.name && !movementTargetsCurrent && lc.action === "move" && outcome !== "failure") {
    const from = world.currentLocation;
    const beforeIds = new Set(workingLocations.map((location) => location.id));
    const destination = addLocation({ ref: lc.ref, name: lc.name, description: lc.description || "Открыто по ходу истории", danger: lc.danger }, true);
    const origin = workingLocations.find((location) => location.current || norm(location.name) === norm(from));
    if (destination) {
      const isNew = !beforeIds.has(destination.id);
      if (!isNew) ops.push({ t: "loc.setCurrent", id: destination.id });
      if (origin && origin.id !== destination.id) ops.push({ t: "loc.connect", fromId: origin.id, toId: destination.id });
      locationApplied = { from, to: destination.name, isNew };
      world.currentLocation = destination.name;
      events.push({ layer: "semantic", category: "location", title: `Локация: ${destination.name}`, content: `${destination.name}: ${lc.description || "без описания"}. Герой прибыл сюда из «${from}» (ход ${turnNumber}).`, importance: 66, entityKey: `location:${slugify(destination.name)}`, mode: "upsert" });
    }
  } else if (lc && lc.action === "move" && outcome === "failure") {
    rejected.push(`Переход в «${lc.name}» отклонён: действие провалено`);
  }

  const connected = new Set<string>();
  for (const route of payload.stateChanges.routes) {
    const from = resolveLocation(route.from), to = resolveLocation(route.to);
    if (!from.location || !to.location) { rejected.push(`Маршрут отклонён: ${from.error ?? to.error}`); continue; }
    if (from.location.id === to.location.id) { rejected.push(`Маршрут отклонён: обе ссылки ведут в «${from.location.name}»`); continue; }
    const key = [from.location.id, to.location.id].sort().join("|");
    if (connected.has(key)) continue;
    connected.add(key);
    ops.push({ t: "loc.connect", fromId: from.location.id, toId: to.location.id });
  }

  // ── Квесты ──
  const questsApplied: AppliedChanges["quests"] = [];
  let newQuests = 0;
  for (const q of payload.stateChanges.quests) {
    const existing = input.quests.find((x) => (q.ref && x.key === q.ref) || (q.title && norm(x.title) === norm(q.title)));
    if (existing) {
      if (existing.status === "completed" || existing.status === "failed") {
        rejected.push(`Квест «${existing.title}» уже ${existing.status === "completed" ? "завершён" : "провален"}`);
        continue;
      }
      const patch: { status?: QuestStatus; progress?: number; description?: string } = {};
      if (q.status && q.status !== existing.status) patch.status = q.status;
      if (q.progress != null && q.progress !== existing.progress) patch.progress = q.progress;
      if (patch.status === "completed") patch.progress = 100;
      if (q.note) patch.description = `${existing.description ? existing.description + " " : ""}[ход ${turnNumber}] ${q.note}`.slice(0, 1200);
      if (Object.keys(patch).length) {
        ops.push({ t: "quest.update", id: existing.id, patch });
        const status = patch.status ?? existing.status;
        const progress = patch.progress ?? existing.progress;
        questsApplied.push({ title: existing.title, status, progress, isNew: false });
        events.push({
          layer: "episodic",
          category: "quest",
          title: `Квест «${existing.title}»: ${status === "completed" ? "завершён" : status === "failed" ? "провален" : `прогресс ${progress}%`}`,
          content: `${q.note || existing.title} (ход ${turnNumber}).`,
          importance: status === "completed" || status === "failed" ? 88 : 72,
          entityKey: `quest:${existing.key}:${status}`,
          mode: status === "active" ? "upsert" : "append",
        });
        if (existing.isMain) world.mainQuest = existing.title;
      }
    } else if (q.title && newQuests < 2) {
      newQuests++;
      const key = slugify(q.title);
      if (input.quests.some((x) => x.key === key)) continue;
      const status = q.status && q.status !== "hidden" ? q.status : "active";
      ops.push({ t: "quest.insert", row: { key, title: q.title, description: q.note, status, progress: q.progress ?? 0, isMain: false } });
      questsApplied.push({ title: q.title, status, progress: q.progress ?? 0, isNew: true });
      events.push({
        layer: "episodic",
        category: "quest",
        title: `Новая цель: ${q.title}`,
        content: `${q.note || q.title} (получена на ходу ${turnNumber}).`,
        importance: 78,
        entityKey: `quest:${key}:new`,
        mode: "append",
      });
    }
  }

  // ── NPC ──
  const npcsApplied: AppliedChanges["npcs"] = [];
  let newNpcs = 0;
  for (const n of payload.stateChanges.npcs) {
    const existing = input.npcs.find((x) => (n.ref && x.key === n.ref) || (n.name && norm(x.name) === norm(n.name)));
    const delta = clampInt(n.relationDelta, -spec.limits.relation, spec.limits.relation);
    if (existing) {
      if (existing.status === "dead" && n.status !== "dead") {
        rejected.push(`NPC «${existing.name}» мёртв — изменения отклонены`);
        continue;
      }
      const relation = Math.max(-100, Math.min(100, existing.relation + delta));
      const status = n.status ?? existing.status;
      ops.push({
        t: "npc.update",
        id: existing.id,
        patch: { relation, status, role: n.role || undefined, description: n.note ? `${existing.description ? existing.description + " " : ""}[ход ${turnNumber}] ${n.note}`.slice(0, 1200) : undefined, lastLocation: world.currentLocation },
      });
      npcsApplied.push({ name: existing.name, relation, delta, status, isNew: false });
      if (Math.abs(delta) >= 10 || status !== existing.status || n.note) {
        events.push({
          layer: "semantic",
          category: "npc",
          title: `NPC: ${existing.name}`,
          content: `${existing.name}${existing.role || n.role ? ` (${n.role || existing.role})` : ""}. Отношение ${relation > 0 ? "+" : ""}${relation}${status !== "alive" ? `, статус: ${status}` : ""}. ${n.note || ""} Последняя встреча: «${world.currentLocation}», ход ${turnNumber}.`,
          importance: status === "dead" ? 90 : 70,
          entityKey: `npc:${existing.key}`,
          mode: "upsert",
        });
      }
    } else if (n.name && newNpcs < 3) {
      newNpcs++;
      const key = slugify(n.name);
      if (input.npcs.some((x) => x.key === key)) continue;
      const relation = Math.max(-100, Math.min(100, delta));
      const status = n.status ?? "alive";
      ops.push({ t: "npc.insert", row: { key, name: n.name, role: n.role, description: n.note, relation, status, lastLocation: world.currentLocation } });
      npcsApplied.push({ name: n.name, relation, delta, status, isNew: true });
      events.push({
        layer: "semantic",
        category: "npc",
        title: `NPC: ${n.name}`,
        content: `${n.name}${n.role ? ` (${n.role})` : ""}. Отношение ${relation > 0 ? "+" : ""}${relation}. ${n.note || ""} Встречен в «${world.currentLocation}», ход ${turnNumber}.`,
        importance: 70,
        entityKey: `npc:${key}`,
        mode: "upsert",
      });
    }
  }

  // ── Инвентарь (INV-1c/d): владение и количество проверяет сервер ──
  const invApplied: AppliedChanges["inventory"] = [];
  const invState = input.inventory.map((i) => ({ ...i }));
  let adds = 0;
  for (const op of payload.stateChanges.inventory) {
    const identity = resolveInventoryReference(invState, op.ref, op.name);
    const found = identity.entity;
    if (identity.error) {
      rejected.push(identity.error);
      invApplied.push({ op: op.op, name: op.name || "Предмет", quantity: op.quantity, ok: false, reason: identity.error });
      continue;
    }
    if (op.op === "add") {
      if (!op.name) continue;
      if (outcome === "failure" && dice) {
        rejected.push(`Предмет «${op.name}» не получен: действие провалено`);
        invApplied.push({ op: "add", name: op.name, quantity: op.quantity, ok: false, reason: "провал" });
        continue;
      }
      if (adds >= 3) {
        rejected.push(`Лимит новых предметов за ход: «${op.name}» пропущен`);
        continue;
      }
      adds++;
      const qty = Math.min(5, op.quantity);
      if (found) {
        found.quantity += qty;
        ops.push({ t: "inv.update", id: found.id, patch: { quantity: found.quantity } });
        invApplied.push({ op: "add", name: found.name, quantity: qty, ok: true });
      } else {
        ops.push({ t: "inv.insert", row: { name: op.name, kind: op.kind, description: op.description, quantity: qty, icon: iconForKind(op.kind) } });
        invApplied.push({ op: "add", name: op.name, quantity: qty, ok: true });
      }
      events.push({
        layer: "semantic",
        category: "item",
        title: `Предмет: ${op.name}`,
        content: `${op.name}${op.kind ? ` (${op.kind})` : ""}: ${op.description || "без описания"}. Получен на ходу ${turnNumber}${found ? `, всего ×${found.quantity}` : qty > 1 ? ` ×${qty}` : ""}.`,
        importance: op.kind === "quest" ? 78 : 60,
        entityKey: `item:${slugify(op.name)}`,
        mode: "upsert",
      });
    } else if (op.op === "consume" || op.op === "remove") {
      if (!found || found.quantity <= 0) {
        rejected.push(`Предмет «${op.name || op.ref}» отсутствует в инвентаре`);
        invApplied.push({ op: op.op, name: op.name || String(op.ref), quantity: op.quantity, ok: false, reason: "нет предмета" });
        continue;
      }
      const qty = op.op === "remove" ? Math.min(found.quantity, Math.max(1, op.quantity)) : Math.min(found.quantity, op.quantity);
      found.quantity -= qty;
      if (found.quantity <= 0) ops.push({ t: "inv.delete", id: found.id });
      else ops.push({ t: "inv.update", id: found.id, patch: { quantity: found.quantity } });
      invApplied.push({ op: op.op, name: found.name, quantity: qty, ok: true });
      // расходник — лечение по power только для профилей с HP
      if (op.op === "consume" && spec.resources.hp && found.kind === "consumable" && found.power > 0) {
        const heal = Math.min(found.power, character.maxHp - character.hp);
        character.hp += heal;
        hp += heal;
      }
      events.push({
        layer: "semantic",
        category: "item",
        title: `Предмет: ${found.name}`,
        content: `${found.name}: ${op.op === "consume" ? "использован" : "утрачен"} на ходу ${turnNumber}${found.quantity > 0 ? `, осталось ×${found.quantity}` : ", больше нет"}.`,
        importance: 58,
        entityKey: `item:${slugify(found.name)}`,
        mode: "upsert",
      });
    } else {
      if (!found) {
        rejected.push(`Нельзя ${op.op === "equip" ? "экипировать" : "снять"} «${op.name || op.ref}»: предмета нет`);
        invApplied.push({ op: op.op, name: op.name || String(op.ref), quantity: 1, ok: false, reason: "нет предмета" });
        continue;
      }
      found.equipped = op.op === "equip";
      ops.push({ t: "inv.update", id: found.id, patch: { equipped: found.equipped } });
      invApplied.push({ op: op.op, name: found.name, quantity: 1, ok: true });
    }
  }

  // ── Объекты сцены (INV-1f) ──
  const sceneApplied: AppliedChanges["sceneObjects"] = [];
  let newObjects = 0;
  for (const o of payload.stateChanges.sceneObjects) {
    const existing = input.sceneObjects.find((x) => (o.ref && x.key === o.ref) || (o.name && norm(x.name) === norm(o.name) && norm(x.locationName) === norm(world.currentLocation)));
    if (existing) {
      if (norm(existing.state) !== norm(o.state) || o.note) {
        ops.push({ t: "scene.update", id: existing.id, patch: { state: o.state, description: o.note || undefined } });
        sceneApplied.push({ name: existing.name, state: o.state, isNew: false });
        events.push({
          layer: "semantic",
          category: "world",
          title: `Объект: ${existing.name} (${world.currentLocation})`,
          content: `${existing.name} в «${world.currentLocation}» — состояние: ${o.state}. ${o.note || ""} (ход ${turnNumber})`,
          importance: 55,
          entityKey: `object:${existing.key}`,
          mode: "upsert",
        });
      }
    } else if (o.name && newObjects < 3) {
      newObjects++;
      const key = `${slugify(world.currentLocation)}:${slugify(o.name)}`;
      if (input.sceneObjects.some((x) => x.key === key)) continue;
      ops.push({ t: "scene.insert", row: { key, name: o.name, state: o.state, description: o.note, locationName: world.currentLocation } });
      sceneApplied.push({ name: o.name, state: o.state, isNew: true });
      events.push({
        layer: "semantic",
        category: "world",
        title: `Объект: ${o.name} (${world.currentLocation})`,
        content: `${o.name} в «${world.currentLocation}» — состояние: ${o.state}. ${o.note || ""} (ход ${turnNumber})`,
        importance: 52,
        entityKey: `object:${key}`,
        mode: "upsert",
      });
    }
  }

  // ── Прочие канонические события ──
  if (dead) {
    events.push({
      layer: "episodic",
      category: "event",
      title: `На грани гибели — ход ${turnNumber}`,
      content: `${character.name} едва не погиб(ла) в «${world.currentLocation}». История продолжается ценой потерь.`,
      importance: 92,
      entityKey: `death:${turnNumber}`,
      mode: "append",
    });
  }
  if (levelUp) {
    events.push({
      layer: "procedural",
      category: "rule",
      title: `Уровень ${character.level}: способности персонажа`,
      content: `Уровень ${character.level}. Статы: ${Object.entries(character.stats).map(([k, v]) => `${k}:${v}`).join(" ")}. Навыки: ${character.skills.join(", ")}. HP ${character.hp}/${character.maxHp}.`,
      importance: 75,
      entityKey: "character:level",
      mode: "upsert",
    });
  }
  if (addedConds.length || removedConds.length) {
    events.push({
      layer: "semantic",
      category: "character",
      title: `Состояние героя`,
      content: character.conditions!.length ? `Текущие состояния ${character.name}: ${character.conditions!.join(", ")} (обновлено на ходу ${turnNumber}).` : `У ${character.name} нет активных состояний (ход ${turnNumber}).`,
      importance: 64,
      entityKey: "character:conditions",
      mode: "upsert",
    });
  }

  return {
    character,
    world,
    outcome,
    ops,
    events,
    applied: {
      hp,
      xp,
      gold,
      danger,
      levelUp,
      dead,
      location: locationApplied,
      quests: questsApplied,
      npcs: npcsApplied,
      inventory: invApplied,
      sceneObjects: sceneApplied,
      conditions: { added: addedConds, removed: removedConds },
      rejected,
    },
  };
}

export function iconForKind(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes("weapon") || k.includes("оруж")) return "🗡️";
  if (k.includes("armor") || k.includes("брон")) return "🛡️";
  if (k.includes("consum") || k.includes("расход") || k.includes("еда")) return "🧪";
  if (k.includes("quest") || k.includes("квест")) return "📜";
  if (k.includes("tool") || k.includes("инстр")) return "🔧";
  if (k.includes("doc") || k.includes("докум")) return "📄";
  if (k.includes("tech") || k.includes("тех")) return "💾";
  if (k.includes("key") || k.includes("ключ")) return "🗝️";
  return "🎒";
}
