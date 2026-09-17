import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  real,
  type AnyPgColumn,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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
  mana: number;
  maxMana: number;
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
  title: text("title").notNull(),
  scenarioId: text("scenario_id").notNull().default("custom"),
  scenarioTitle: text("scenario_title").notNull().default("Своя история"),
  scenarioPrompt: text("scenario_prompt").notNull().default(""),
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
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: timestamp("last_accessed_at").defaultNow(),
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
//  Вектор хранится как real[] — переносимо без pgvector; поиск идёт
//  строго внутри sessionId, поэтому cosine на стороне приложения дёшев.
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
  id: text("id").primaryKey(), // singleton: 'global'
  keys: jsonb("keys").$type<string[]>().default([]),
  routingProfile: text("routing_profile").notNull().default("balanced"),
  narrationModel: text("narration_model").notNull().default("gemini-3.5-flash-lite"),
  customActionModel: text("custom_action_model").notNull().default("gemini-3.8-flash"),
  compactionModel: text("compaction_model").notNull().default("gemini-3.8-flash"),
  fastTaskModel: text("fast_task_model").notNull().default("gemini-3.5-flash-lite"),
  primaryModel: text("primary_model").notNull().default("gemini-3.5-flash-lite"),
  fallbackChain: jsonb("fallback_chain")
    .$type<string[]>()
    .default(["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]),
  useLiveAI: boolean("use_live_ai").notNull().default(false),
  dailyFlashLimit: integer("daily_flash_limit").notNull().default(20),
  dailyLiteLimit: integer("daily_lite_limit").notNull().default(500),
  // DATA-1d: принудительное соблюдение дневных лимитов на сервере
  enforceLimits: boolean("enforce_limits").notNull().default(true),
  // MEM-2: эмбеддинги
  embeddingsEnabled: boolean("embeddings_enabled").notNull().default(true),
  embeddingModel: text("embedding_model").notNull().default("gemini-embedding-2"),
  embeddingDims: integer("embedding_dims").notNull().default(768),
  // MEM-1: асинхронный semantic-extractor
  semanticExtractionEnabled: boolean("semantic_extraction_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────────
//  Лог токенов / вызовов
// ─────────────────────────────────────────────────────────────
export const tokenLogs = pgTable(
  "token_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id").references(() => gameSessions.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    taskType: text("task_type").notNull(), // narration | resolution | compaction | fast | embedding
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

/** Local, single-owner workspace. Add ownership/RLS before multi-user deployment. */
export const workspacePreferences = pgTable("workspace_preferences", {
  id: text("id").primaryKey().default("local"),
  displayName: text("display_name").notNull().default("Искатель историй"),
  favorites: jsonb("favorites").notNull().$type<string[]>().default([]),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
