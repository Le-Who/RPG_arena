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
} from "drizzle-orm/pg-core";

// ── Игровые сессии (кампании) ─────────────────────────────
export const gameSessions = pgTable("game_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  scenarioId: text("scenario_id").notNull().default("custom"),
  scenarioTitle: text("scenario_title").notNull().default("Своя история"),
  scenarioPrompt: text("scenario_prompt").notNull().default(""),
  character: jsonb("character").notNull().$type<CharacterState>(),
  worldState: jsonb("world_state").notNull().$type<WorldState>(),
  status: text("status").notNull().default("active"), // active | finished | paused
  turnCount: integer("turn_count").notNull().default(0),
  contextTokensEstimate: integer("context_tokens_estimate").notNull().default(0),
  // lastCompactTurn: номер последнего хода, вошедшего в компакцию.
  // Используется в shouldCompact и compact/route.ts для точного окна сжатия.
  // Исключает ненадёжный поиск по chronicle-нодам (баг #4).
  lastCompactTurn: integer("last_compact_turn").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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
  stats: Record<string, number>; // СИЛ ЛОВ ИНТ МУД ХАР ВЫН
  skills: string[];
  traits: string[];
  backstory: string;
  appearance: string;
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

// ── Ходы / реплики ────────────────────────────────────────
export const gameTurns = pgTable("game_turns", {
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_game_turns_session_id").on(t.sessionId),
  index("idx_game_turns_session_role_turn").on(t.sessionId, t.role, t.turnNumber),
  index("idx_game_turns_session_turn_desc").on(t.sessionId, t.turnNumber),
]);

export type DiceResult = {
  d20: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
  critical: "crit" | "fumble" | null;
  skill: string;
  label: string;
};

// ── Древо памяти (Memory House: 5 слоёв) ──────────────────
export const memoryNodes = pgTable("memory_nodes", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => gameSessions.id, { onDelete: "cascade" }),
  layer: text("layer").notNull(), // working | episodic | semantic | procedural | chronicle
  category: text("category").notNull(), // character | world | event | quest | npc | item | rule
  title: text("title").notNull(),
  content: text("content").notNull(),
  importance: real("importance").notNull().default(50), // 0-100
  salience: real("salience").notNull().default(50),
  tokensEstimate: integer("tokens_estimate").notNull().default(0),
  // parentId: self-referencing FK для иерархии нод (дочерние ноды → родительская нода).
  // onDelete: set null — удаление родителя не каскадирует на дочерние.
  parentId: uuid("parent_id").references((): AnyPgColumn => memoryNodes.id, { onDelete: "set null" }),
  turnFrom: integer("turn_from").default(0),
  turnTo: integer("turn_to").default(0),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: timestamp("last_accessed_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_memory_nodes_session_importance").on(t.sessionId, t.importance),
  index("idx_memory_nodes_session_turnto").on(t.sessionId, t.turnTo),
]);

// memoryLinks: граф связей между нодами памяти (зарезервировано для будущего графового поиска).
// В текущей версии таблица создаётся, но не используется в запросах.
// FK намеренно без каскадного удаления — для ручного управления связями.
export const memoryLinks = pgTable("memory_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  fromId: uuid("from_id")
    .notNull()
    .references(() => memoryNodes.id, { onDelete: "cascade" }),
  toId: uuid("to_id")
    .notNull()
    .references(() => memoryNodes.id, { onDelete: "cascade" }),
  relation: text("relation").notNull().default("relates"), // causes | owns | knows | located | child
});

// ── Инвентарь ─────────────────────────────────────────────
export const inventoryItems = pgTable("inventory_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => gameSessions.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("misc"), // weapon | armor | consumable | quest | misc | spell
  description: text("description").notNull().default(""),
  quantity: integer("quantity").notNull().default(1),
  equipped: boolean("equipped").notNull().default(false),
  power: integer("power").notNull().default(0),
  icon: text("icon").notNull().default("🎒"),
}, (t) => [
  index("idx_inventory_items_session_id").on(t.sessionId),
]);

// ── Карта мира ────────────────────────────────────────────
export const worldLocations = pgTable("world_locations", {
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
}, (t) => [
  index("idx_world_locations_session_id").on(t.sessionId),
]);

// ── Настройки ИИ (ключи, маршрутизация) ───────────────────
export const aiSettings = pgTable("ai_settings", {
  id: text("id").primaryKey(), // singleton: 'global'
  keys: jsonb("keys").$type<string[]>().default([]),
  routingProfile: text("routing_profile").notNull().default("balanced"), // balanced | economy | flagship | custom
  narrationModel: text("narration_model").notNull().default("gemini-3.5-flash-lite"), // Lite для обычных ходов
  customActionModel: text("custom_action_model").notNull().default("gemini-3.8-flash"), // 3.8 для свободных действий
  compactionModel: text("compaction_model").notNull().default("gemini-3.8-flash"), // 3.8 для сжатия памяти
  fastTaskModel: text("fast_task_model").notNull().default("gemini-3.5-flash-lite"), // Lite для извлечения фактов
  primaryModel: text("primary_model").notNull().default("gemini-3.5-flash-lite"),
  fallbackChain: jsonb("fallback_chain")
    .$type<string[]>()
    .default(["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]),
  useLiveAI: boolean("use_live_ai").notNull().default(false),
  dailyFlashLimit: integer("daily_flash_limit").notNull().default(20),
  dailyLiteLimit: integer("daily_lite_limit").notNull().default(500),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Лог токенов ───────────────────────────────────────────
export const tokenLogs = pgTable("token_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => gameSessions.id, {
    onDelete: "set null",
  }),
  model: text("model").notNull(),
  taskType: text("task_type").notNull(), // narration | resolution | compaction | fast | embedding_hint
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  success: boolean("success").notNull().default(true),
  error: text("error").default(""),
  keyIndex: integer("key_index").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_token_logs_session_id").on(t.sessionId),
  index("idx_token_logs_created_at").on(t.createdAt),
]);
