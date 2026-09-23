import { sql } from "drizzle-orm";
import type { AgreementRevision, AgreementStatus } from "@/lib/narrative-agreements";
import type { TurnResponse, TurnStage } from "@/lib/turn-contract";
import type { CheckpointSnapshot } from "@/lib/checkpoint-types";
import type { TypeSafeReport } from "@/lib/typesafe-report";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  date,
  primaryKey,
  boolean,
  jsonb,
  timestamp,
  real,
  type AnyPgColumn,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey(),
  login: text("login").notNull().unique(),
  profileId: text("profile_id").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const accountSessions = pgTable("account_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("account_sessions_account_idx").on(table.accountId)]);
export const consumedGuestProfiles = pgTable("consumed_guest_profiles", {
  profileId: text("profile_id").primaryKey(),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull().defaultNow(),
});
export const authRateLimits = pgTable("auth_rate_limits", {
  bucket: text("bucket").primaryKey(),
  attempts: integer("attempts").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const ownerActivity = pgTable("owner_activity", {
  id: uuid("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("owner_activity_owner_idx").on(table.ownerId)]);

// ─────────────────────────────────────────────────────────────
//  Общие типы домена
// ─────────────────────────────────────────────────────────────

/** Режим кампании: preset — авторская история с офлайн-фолбэком; free — AI-first. */
export type CampaignMode = "preset" | "free";

/** Профиль механик кампании (ARCH-1 / MECH-1). */
export type RulesProfile = "d20" | "rules-light" | "narrative";

export type CharacterState = {
  name: string;
  archetype: string;
  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  gold: number;
  stats: Record<string, number>; // d20: СИЛ ЛОВ ВЫН ИНТ МУД ХАР; иные профили — может быть пустым
  skills: string[];
  traits: string[];
  backstory: string;
  appearance: string;
  /** Состояния героя для rules-light/narrative («ранен», «под подозрением»…). */
  conditions?: string[];
};

export type WorldState = {
  worldName: string;
  tone: string;
  era: string;
  mainQuest: string;
  currentLocation: string;
  factions: string[];
  flags: Record<string, boolean | string | number>;
  danger: number; // 0-100 накал
  chapter: number;
};

export type DiceResult = {
  /** Server-bound action being checked; legacy rolls infer it from the saved player turn. */
  goal?: string;
  d20: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
  critical: "crit" | "fumble" | null;
  skill: string;
  label: string;
  /** Тип проверки: d20 (классика) или 2d6 риск-проверка rules-light. */
  kind?: "d20" | "2d6";
  /** Для 2d6: полный успех / успех с ценой / провал. */
  band?: "full" | "cost" | "fail";
};

/** Сводка применённых изменений состояния — возвращается клиенту и хранится в ходе (RES-1h). */
export type AppliedChanges = {
  hp: number;
  xp: number;
  gold: number;
  danger: number;
  levelUp: boolean;
  dead: boolean;
  location: { from: string; to: string; isNew: boolean } | null;
  quests: { title: string; status: string; progress: number; isNew: boolean }[];
  npcs: { name: string; relation: number; delta: number; status: string; isNew: boolean }[];
  inventory: { op: string; name: string; quantity: number; ok: boolean; reason?: string }[];
  sceneObjects: { name: string; state: string; isNew: boolean }[];
  conditions: { added: string[]; removed: string[] };
  rejected: string[]; // причины отклонённых изменений (наблюдаемость)
};

export type TurnContextMeta = {
  narrativeVerification?: {
    version: 1; reasons: string[]; repaired: boolean; emittedCharacters: number;
    textSha256?: string;
    checks: import("../lib/narrative-verifier").NarrativeVerification[];
    checkSelections?: import("../lib/narrative-policy").NarrativeCheckSelection[];
    reviews?: { attempt: number; result: import("../lib/narrative-review").NarrativeReview; model: string; latencyMs: number }[];
    evidence: import("../lib/narrative-evidence").NarrativeEvidence;
  };
  timings?: import("../lib/turn-contract").TurnTimings;
  model: string;
  rulesProfile: RulesProfile;
  digestChars: number;
  retrievedIds: string[]; // ноды памяти, найденные семантическим поиском
  retrievalMs?: number;
  skippedModels?: string[]; // модели, пропущенные из-за дневных лимитов
};

// ─────────────────────────────────────────────────────────────
//  Игровые сессии (кампании)
// ─────────────────────────────────────────────────────────────
export const gameSessions = pgTable("game_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: text("owner_id"),
  visibility: text("visibility").notNull().default("private").$type<"private" | "public">(),
  title: text("title").notNull(),
  scenarioId: text("scenario_id").notNull().default("custom"),
  scenarioTitle: text("scenario_title").notNull().default("Своя история"),
  scenarioPrompt: text("scenario_prompt").notNull().default(""),
  branchOrigin: jsonb("branch_origin").$type<{ sessionId: string; sessionTitle: string; checkpointId: string; checkpointTitle: string; turn: number } | null>().default(null),
  // ARCH-1a: режим и профиль хранятся явно, а не выводятся из scenarioId
  campaignMode: text("campaign_mode").notNull().default("preset").$type<CampaignMode>(),
  rulesProfile: text("rules_profile").notNull().default("d20").$type<RulesProfile>(),
  character: jsonb("character").notNull().$type<CharacterState>(),
  worldState: jsonb("world_state").notNull().$type<WorldState>(),
  status: text("status").notNull().default("active"), // active | finished | paused
  turnCount: integer("turn_count").notNull().default(0),
  contextTokensEstimate: integer("context_tokens_estimate").notNull().default(0),
  lastCompactTurn: integer("last_compact_turn").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────────
//  Ходы / реплики
// ─────────────────────────────────────────────────────────────
export const gameTurns = pgTable(
  "game_turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    turnNumber: integer("turn_number").notNull(),
    role: text("role").notNull(), // narrator | player | system | dice | memory
    content: text("content").notNull(),
    // Migration 0009 owns the DB-only generated evidence_search vector and GIN index.
    // Keep it out of ORM row selection, client snapshots and campaign copies.
    choices: jsonb("choices").$type<string[]>().default([]),
    dice: jsonb("dice").$type<DiceResult | null>().default(null),
    modelUsed: text("model_used"),
    taskType: text("task_type"), // narration | resolution | compaction | fast
    promptTokens: integer("prompt_tokens").default(0),
    completionTokens: integer("completion_tokens").default(0),
    // RES-1f: idempotency-ключ запроса клиента (только у player-ходов)
    requestId: text("request_id"),
    // RES-1h: применённые изменения состояния (у narrator-ходов)
    stateChanges: jsonb("state_changes").$type<AppliedChanges | null>().default(null),
    // MEM-2e: наблюдаемость контекста — какие ноды были извлечены, какая модель
    contextMeta: jsonb("context_meta").$type<TurnContextMeta | null>().default(null),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_game_turns_session_id").on(t.sessionId),
    index("idx_game_turns_session_role_turn").on(t.sessionId, t.role, t.turnNumber),
    index("idx_game_turns_session_turn_desc").on(t.sessionId, t.turnNumber),
    uniqueIndex("uq_game_turns_session_request").on(t.sessionId, t.requestId),
  ],
);

// ─────────────────────────────────────────────────────────────
//  Древо памяти (Memory House: 5 слоёв) + provenance (MEM-1a)
// ─────────────────────────────────────────────────────────────
export type MemorySource = "seed" | "state" | "ai-semantic" | "compaction" | "heuristic";

export const memoryNodes = pgTable(
  "memory_nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    layer: text("layer").notNull(), // episodic | semantic | procedural | chronicle
    category: text("category").notNull(), // character | world | event | quest | npc | item | rule | location
    title: text("title").notNull(),
    content: text("content").notNull(),
    importance: real("importance").notNull().default(50),
    salience: real("salience").notNull().default(50),
    tokensEstimate: integer("tokens_estimate").notNull().default(0),
    parentId: uuid("parent_id").references((): AnyPgColumn => memoryNodes.id, { onDelete: "set null" }),
    turnFrom: integer("turn_from").default(0),
    turnTo: integer("turn_to").default(0),
    // ── provenance ──
    source: text("source").notNull().default("heuristic").$type<MemorySource>(),
    sourceTurn: integer("source_turn"),
    contentHash: text("content_hash"),
    /** Канонический ключ сущности/отношения: quest:<key>, npc:<key>, item:<id>, location:<slug> */
    entityKey: text("entity_key"),
    confidence: real("confidence").notNull().default(1),
    evidence: text("evidence"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_memory_nodes_session_importance").on(t.sessionId, t.importance),
    index("idx_memory_nodes_session_turnto").on(t.sessionId, t.turnTo),
    index("idx_memory_nodes_session_hash").on(t.sessionId, t.contentHash),
    index("idx_memory_nodes_session_entity").on(t.sessionId, t.entityKey),
  ],
);

export const memoryLinks = pgTable("memory_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  fromId: uuid("from_id")
    .notNull()
    .references(() => memoryNodes.id, { onDelete: "cascade" }),
  toId: uuid("to_id")
    .notNull()
    .references(() => memoryNodes.id, { onDelete: "cascade" }),
  relation: text("relation").notNull().default("relates"),
});

// ─────────────────────────────────────────────────────────────
//  Эмбеддинги памяти (MEM-2): версионируемое хранилище + outbox-статус
//  real[] сохраняет совместимость со старыми версиями приложения/worker.
//  После миграции 0006 pgvector считает точный рейтинг внутри sessionId в БД.
// ─────────────────────────────────────────────────────────────
export type EmbeddingStatus = "pending" | "processing" | "ready" | "failed";

export const memoryEmbeddings = pgTable(
  "memory_embeddings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memoryNodeId: uuid("memory_node_id")
      .notNull()
      .references(() => memoryNodes.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    dims: integer("dims").notNull().default(768),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull().default("pending").$type<EmbeddingStatus>(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
    attempts: integer("attempts").notNull().default(0),
    error: text("error").default(""),
    vector: real("vector").array(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_memory_embeddings_node").on(t.memoryNodeId),
    index("idx_memory_embeddings_session_status").on(t.sessionId, t.status),
  ],
);

// ─────────────────────────────────────────────────────────────
//  Инвентарь
// ─────────────────────────────────────────────────────────────
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("misc"), // weapon | armor | consumable | quest | misc | tool | document | tech
    description: text("description").notNull().default(""),
    quantity: integer("quantity").notNull().default(1),
    equipped: boolean("equipped").notNull().default(false),
    power: integer("power").notNull().default(0),
    icon: text("icon").notNull().default("🎒"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("idx_inventory_items_session_id").on(t.sessionId)],
);

// ─────────────────────────────────────────────────────────────
//  Карта мира
// ─────────────────────────────────────────────────────────────
export const worldLocations = pgTable(
  "world_locations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    x: integer("x").notNull().default(0),
    y: integer("y").notNull().default(0),
    discovered: boolean("discovered").notNull().default(false),
    current: boolean("current").notNull().default(false),
    danger: integer("danger").notNull().default(10),
    icon: text("icon").notNull().default("📍"),
    connectedTo: jsonb("connected_to").$type<string[]>().default([]),
  },
  (t) => [index("idx_world_locations_session_id").on(t.sessionId)],
);

// ─────────────────────────────────────────────────────────────
//  Квесты (RES-1a): нормализованное хранилище вместо строки mainQuest
// ─────────────────────────────────────────────────────────────
export type QuestStatus = "active" | "completed" | "failed" | "hidden";

export const quests = pgTable(
  "quests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // slug, стабильный идентификатор для AI
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("active").$type<QuestStatus>(),
    progress: integer("progress").notNull().default(0), // 0-100
    isMain: boolean("is_main").notNull().default(false),
    updatedTurn: integer("updated_turn").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_quests_session_key").on(t.sessionId, t.key)],
);

// ─────────────────────────────────────────────────────────────
//  NPC и отношения (RES-1a)
// ─────────────────────────────────────────────────────────────
export type NpcStatus = "alive" | "dead" | "missing" | "unknown";

export const npcs = pgTable(
  "npcs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    description: text("description").notNull().default(""),
    relation: integer("relation").notNull().default(0), // -100 (враг) … +100 (союзник)
    status: text("status").notNull().default("alive").$type<NpcStatus>(),
    lastSeenTurn: integer("last_seen_turn").notNull().default(0),
    lastLocation: text("last_location").notNull().default(""),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_npcs_session_key").on(t.sessionId, t.key)],
);

// ─────────────────────────────────────────────────────────────
//  Объекты сцены (INV-1f): окружение как состояние, а не только текст
// ─────────────────────────────────────────────────────────────
export const sceneObjects = pgTable(
  "scene_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    locationName: text("location_name").notNull().default(""),
    state: text("state").notNull().default("intact"), // произвольное короткое состояние: «заперт», «сломан», «открыт»
    description: text("description").notNull().default(""),
    interactable: boolean("interactable").notNull().default(true),
    updatedTurn: integer("updated_turn").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_scene_objects_session_key").on(t.sessionId, t.key)],
);

// ─────────────────────────────────────────────────────────────
//  Настройки ИИ (ключи, маршрутизация, эмбеддинги)
// ─────────────────────────────────────────────────────────────
export const aiSettings = pgTable("ai_settings", {
  id: text("id").primaryKey(), // authenticated profile identifier; legacy 'global' is quarantined
  keys: jsonb("keys").$type<string[]>().default([]),
  routingProfile: text("routing_profile").notNull().default("balanced"),
  narrationModel: text("narration_model").notNull().default("gemini-3.5-flash-lite"),
  customActionModel: text("custom_action_model").notNull().default("gemini-3.8-flash"),
  compactionModel: text("compaction_model").notNull().default("gemini-3.8-flash"),
  fastTaskModel: text("fast_task_model").notNull().default("gemini-3.5-flash-lite"),
  useLiveAI: boolean("use_live_ai").notNull().default(false),
  dailyFlashLimit: integer("daily_flash_limit").notNull().default(20),
  dailyLiteLimit: integer("daily_lite_limit").notNull().default(500),
  keysSharedProject: boolean("keys_shared_project").notNull().default(true),
  dailyEmbeddingLimit: integer("daily_embedding_limit").notNull().default(5000),
  // DATA-1d: принудительное соблюдение дневных лимитов на сервере
  enforceLimits: boolean("enforce_limits").notNull().default(true),
  // MEM-2: эмбеддинги
  embeddingsEnabled: boolean("embeddings_enabled").notNull().default(true),
  embeddingModel: text("embedding_model").notNull().default("gemini-embedding-2"),
  embeddingDims: integer("embedding_dims").notNull().default(768),
  // MEM-1: асинхронный semantic-extractor
  semanticExtractionEnabled: boolean("semantic_extraction_enabled").notNull().default(true),
  typesafeKey: text("typesafe_key").notNull().default(""),
  typesafePilotEnabled: boolean("typesafe_pilot_enabled").notNull().default(false),
  narrativeGuardEnabled: boolean("narrative_guard_enabled").notNull().default(true),
  narrativeGuardProvider: text("narrative_guard_provider").notNull().default("openrouter"),
  narrativeGuardKey: text("narrative_guard_key").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────────
//  Лог токенов / вызовов
// ─────────────────────────────────────────────────────────────
export const tokenLogs = pgTable(
  "token_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id"),
    sessionId: uuid("session_id").references(() => gameSessions.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    taskType: text("task_type").notNull(), // narration | resolution | compaction | fast | embedding
    quotaReserved: boolean("quota_reserved").notNull().default(false),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    success: boolean("success").notNull().default(true),
    error: text("error").default(""),
    keyIndex: integer("key_index").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_token_logs_session_id").on(t.sessionId),
    index("idx_token_logs_created_at").on(t.createdAt),
    index("idx_token_logs_model_created").on(t.model, t.createdAt),
  ],
);

export const modelCallQuotas = pgTable("model_call_quotas", {
  ownerId: text("owner_id").notNull(),
  scope: text("scope").notNull(),
  model: text("model").notNull(),
  day: date("day").notNull(),
  attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
  legacyUsed: bigint("legacy_used", { mode: "number" }).notNull().default(0),
}, t => [primaryKey({ columns: [t.ownerId, t.scope, t.model, t.day] })]);

/** Reading preferences belong to the current authenticated or guest profile. */
export type ReadingPreferences = {
  textScale: "compact" | "normal" | "large";
  measure: "narrow" | "normal" | "wide";
  theme: "midnight" | "sepia" | "contrast";
  motion: "full" | "reduced";
};

export const workspacePreferences = pgTable("workspace_preferences", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull().default("Искатель историй"),
  favorites: jsonb("favorites").notNull().$type<string[]>().default([]),
  /** Guest profiles persist while the browser retains its identity cookie. */
  reading: jsonb("reading").notNull().$type<ReadingPreferences>().default({ textScale: "normal", measure: "normal", theme: "midnight", motion: "full" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// A lease fences expensive work before provider calls. Completion is atomic with the turn.
export const turnRequests = pgTable("turn_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => gameSessions.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(), inputHash: text("input_hash").notNull(),
  action: text("action").notNull(), isFree: boolean("is_free").notNull(), baseTurn: integer("base_turn").notNull(),
  status: text("status").notNull().$type<"running" | "completed" | "failed">(),
  stage: text("stage").notNull().$type<TurnStage>().default("context"),
  leaseToken: uuid("lease_token"), leaseExpiresAt: timestamp("lease_expires_at"),
  dice: jsonb("dice").$type<DiceResult | null>(), result: jsonb("result").$type<TurnResponse | null>(),
  error: text("error"), attempts: integer("attempts").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("uq_turn_request_key").on(t.sessionId, t.requestId), uniqueIndex("uq_running_turn_session").on(t.sessionId).where(sql`${t.status} = 'running'`), index("idx_turn_requests_status_updated").on(t.status, t.updatedAt)]);

export type MemoryJobPayload = { narration: string; playerAction: string; profileCanon: string; knownDigest: string };
export const memoryJobs = pgTable("memory_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => gameSessions.id, { onDelete: "cascade" }),
  turnNumber: integer("turn_number").notNull(), kind: text("kind").notNull().default("semantic"),
  payload: jsonb("payload").notNull().$type<MemoryJobPayload>(),
  status: text("status").notNull().default("pending").$type<"pending" | "processing" | "completed" | "failed">(),
  attempts: integer("attempts").notNull().default(0), leaseToken: uuid("lease_token"), leaseExpiresAt: timestamp("lease_expires_at"),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(), error: text("error"), factsCount: integer("facts_count").notNull().default(0),
  typesafeReport: jsonb("typesafe_report").$type<TypeSafeReport | null>(),
  createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("uq_memory_job_turn_kind").on(t.sessionId, t.turnNumber, t.kind), index("idx_memory_jobs_ready").on(t.status, t.nextAttemptAt)]);

export const campaignCheckpoints = pgTable("campaign_checkpoints", {
  id: uuid("id").defaultRandom().primaryKey(), sessionId: uuid("session_id").notNull().references(() => gameSessions.id, { onDelete: "cascade" }),
  title: text("title").notNull(), turnNumber: integer("turn_number").notNull(), requestId: text("request_id").notNull(),
  snapshot: jsonb("snapshot").notNull().$type<CheckpointSnapshot>(), checksum: text("checksum").notNull(),
  summary: jsonb("summary").notNull().$type<{ character: string; location: string; memories: number; items: number; turns: number; pendingFacts: number }>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("idx_checkpoints_session_turn").on(t.sessionId, t.turnNumber), uniqueIndex("uq_checkpoint_request").on(t.sessionId, t.requestId)]);

export const checkpointForks = pgTable("checkpoint_forks", {
  id: uuid("id").defaultRandom().primaryKey(), checkpointId: uuid("checkpoint_id").notNull().references(() => campaignCheckpoints.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(), inputHash: text("input_hash").notNull(),
  branchId: uuid("branch_id").references(() => gameSessions.id, { onDelete: "set null" }), createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("uq_checkpoint_fork_request").on(t.checkpointId, t.requestId)]);

/** Import keys survive deletion of their target, so a retry cannot resurrect it. */
export const campaignImports = pgTable("campaign_imports", {
  ownerId: text("owner_id").notNull(),
  requestId: text("request_id").notNull(),
  inputHash: text("input_hash").notNull(),
  campaignId: uuid("campaign_id").references(() => gameSessions.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.ownerId, t.requestId] })]);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  id: text("id").primaryKey(), status: text("status").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  report: jsonb("report").$type<{ extracted: number; indexed: number; failed: number; elapsedMs: number }>(),
});

/** Append-only accepted agreement revisions. Existing campaign prose is never auto-imported. */
export const agreementEvents = pgTable("agreement_events", {
  id: uuid("id").primaryKey(),
  agreementId: uuid("agreement_id").notNull(),
  sessionId: uuid("session_id").notNull().references(() => gameSessions.id, { onDelete: "cascade" }),
  turnNumber: integer("turn_number").notNull(),
  version: integer("version").notNull(),
  previousRevisionId: uuid("previous_revision_id"),
  parties: jsonb("parties").notNull().$type<string[]>(),
  object: text("object").notNull(),
  consideration: text("consideration").notNull(),
  conditions: jsonb("conditions").notNull().$type<string[]>(),
  status: text("status").notNull().$type<AgreementStatus>(),
  rulesVersion: integer("rules_version").notNull().$type<1>(),
  source: jsonb("source").notNull().$type<AgreementRevision["source"]>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("uq_agreement_revision").on(t.agreementId, t.version), index("idx_agreement_session_turn").on(t.sessionId, t.turnNumber)]);
