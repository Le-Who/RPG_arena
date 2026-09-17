# Audit Findings Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Fix 9 defects found in RPG Arena audit: DB indexes, double-click race, memory recency, responseSchema, dice-before-AI refactor.

**Architecture:** Tasks T1–T4 are surgical 1-2 file edits. T5 is architectural refactor of the resolution path in act/route.ts + gemini.ts. Order: T1→T2→T3→T4→T5.

**Tech Stack:** Next.js 14 App Router, Drizzle ORM, PostgreSQL, TypeScript, Gemini REST API v1beta

**Spec:** audit_report.md (verified in current session)

## Global Constraints

- TypeScript strict — no `any` without explicit cast
- Drizzle ORM for all DB queries — raw SQL only in migration .sql files
- All schema changes via new `drizzle/patch_indexes.sql` (DO NOT modify `0000_foamy_slapstick.sql`)
- Narrative strings in Russian
- No breaking changes in API contract (`/api/sessions/[id]/act` response fields unchanged)
- `callGeminiWithRotation` signature extended with optional `responseSchema` only
- Verify via `npx tsc --noEmit` after each task

---

### Task 1: DB Indexes Migration

**Files:**
- Create: `drizzle/patch_indexes.sql`
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Create `drizzle/patch_indexes.sql`**

Create the file with this exact content:

```sql
-- ============================================================
-- Patch: performance indexes for high-frequency queries
-- Apply: psql $DATABASE_URL -f drizzle/patch_indexes.sql
-- ============================================================

-- game_turns: base index on session_id
CREATE INDEX IF NOT EXISTS idx_game_turns_session_id
  ON game_turns (session_id);

-- game_turns: composite for playerCountResult (WHERE session_id=? AND role='player' AND turn_number > ?)
CREATE INDEX IF NOT EXISTS idx_game_turns_session_role_turn
  ON game_turns (session_id, role, turn_number);

-- game_turns: ORDER BY turn_number DESC + LIMIT (recentTurns fetch)
CREATE INDEX IF NOT EXISTS idx_game_turns_session_turn_desc
  ON game_turns (session_id, turn_number DESC);

-- memory_nodes: WHERE session_id + ORDER BY weighted rank
CREATE INDEX IF NOT EXISTS idx_memory_nodes_session_importance
  ON memory_nodes (session_id, importance DESC);

-- memory_nodes: recency query (session_id, turn_to DESC)
CREATE INDEX IF NOT EXISTS idx_memory_nodes_session_turnto
  ON memory_nodes (session_id, turn_to DESC);

-- inventory_items: WHERE session_id = ?
CREATE INDEX IF NOT EXISTS idx_inventory_items_session_id
  ON inventory_items (session_id);

-- world_locations: WHERE session_id = ?
CREATE INDEX IF NOT EXISTS idx_world_locations_session_id
  ON world_locations (session_id);

-- token_logs: WHERE session_id (analytics)
CREATE INDEX IF NOT EXISTS idx_token_logs_session_id
  ON token_logs (session_id);

-- token_logs: ORDER BY created_at DESC (monitoring)
CREATE INDEX IF NOT EXISTS idx_token_logs_created_at
  ON token_logs (created_at DESC);
```

- [ ] **Step 2: Add `index` import and index declarations in `src/db/schema.ts`**

Add `index` to imports at line 1-11 of schema.ts:
```ts
import {
  pgTable, uuid, text, integer, boolean, jsonb,
  timestamp, real, type AnyPgColumn,
  index,
} from "drizzle-orm/pg-core";
```

Change `gameTurns` declaration to add third argument after the columns object:
```ts
export const gameTurns = pgTable("game_turns", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => gameSessions.id, { onDelete: "cascade" }),
  turnNumber: integer("turn_number").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  choices: jsonb("choices").$type<string[]>().default([]),
  dice: jsonb("dice").$type<DiceResult | null>().default(null),
  modelUsed: text("model_used"),
  taskType: text("task_type"),
  promptTokens: integer("prompt_tokens").default(0),
  completionTokens: integer("completion_tokens").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_game_turns_session_id").on(t.sessionId),
  index("idx_game_turns_session_role_turn").on(t.sessionId, t.role, t.turnNumber),
  index("idx_game_turns_session_turn_desc").on(t.sessionId, t.turnNumber),
]);
```

Change `memoryNodes` declaration:
```ts
export const memoryNodes = pgTable("memory_nodes", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => gameSessions.id, { onDelete: "cascade" }),
  layer: text("layer").notNull(),
  category: text("category").notNull(),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_memory_nodes_session_importance").on(t.sessionId, t.importance),
  index("idx_memory_nodes_session_turnto").on(t.sessionId, t.turnTo),
]);
```

Change `inventoryItems` declaration:
```ts
export const inventoryItems = pgTable("inventory_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => gameSessions.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("misc"),
  description: text("description").notNull().default(""),
  quantity: integer("quantity").notNull().default(1),
  equipped: boolean("equipped").notNull().default(false),
  power: integer("power").notNull().default(0),
  icon: text("icon").notNull().default("🎒"),
}, (t) => [
  index("idx_inventory_items_session_id").on(t.sessionId),
]);
```

Change `worldLocations` declaration:
```ts
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
```

Change `tokenLogs` declaration:
```ts
export const tokenLogs = pgTable("token_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => gameSessions.id, {
    onDelete: "set null",
  }),
  model: text("model").notNull(),
  taskType: text("task_type").notNull(),
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
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd e:\Projects\RPG_arena && npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add drizzle/patch_indexes.sql src/db/schema.ts
git commit -m "perf: add DB indexes for session_id, role, turn_number, importance"
```

---

### Task 2: Double-Click Guard via Ref

**Files:**
- Modify: `src/app/play/[id]/page.tsx`

**Context:** `busyRef` is declared at line 95, `compactingRef` at line 97. The guard in `act()` at line 127 uses React state (`busy`, `compacting`) which is stale until next render. Two fast clicks both see `busy=false` before the first re-render.

- [ ] **Step 1: Fix guard in `act()` — use refs instead of state**

Find line 127 in `src/app/play/[id]/page.tsx`:
```ts
if (!text.trim() || busy || compacting) return;
```

Replace with:
```ts
if (!text.trim() || busyRef.current || compactingRef.current) return;
```

- [ ] **Step 2: Add guard in `compact()`**

Find the start of `compact()` function (around line 176):
```ts
async function compact() {
  setCompacting(true);
```

Replace with:
```ts
async function compact() {
  if (compactingRef.current) return;
  setCompacting(true);
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd e:\Projects\RPG_arena && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/app/play/[id]/page.tsx
git commit -m "fix: use busyRef/compactingRef guards to prevent double-click race in act() and compact()"
```

---

### Task 3: Memory Recency — Weighted ORDER BY

**Files:**
- Modify: `src/app/api/sessions/[id]/act/route.ts`

**Context:** Current query uses `orderBy(desc(memoryNodes.importance))` only. `salience` and recency via `turnTo` are only applied after the top-60 filter. NPC nodes (importance≈70) get evicted by old events (importance≥82) before salience decay runs.

- [ ] **Step 1: Add `sql` to drizzle-orm imports**

Find line 4 in `src/app/api/sessions/[id]/act/route.ts`:
```ts
import { and, count, desc, eq, gt } from "drizzle-orm";
```

Replace with:
```ts
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
```

- [ ] **Step 2: Replace memory query ORDER BY**

Find lines 137-142:
```ts
  const mems = await db
    .select()
    .from(memoryNodes)
    .where(eq(memoryNodes.sessionId, id))
    .orderBy(desc(memoryNodes.importance))
    .limit(60);
```

Replace with:
```ts
  // Weighted rank: importance×0.7 + salience×0.3
  // Ensures fresh NPC nodes (high salience, mid importance) aren't evicted
  // by old events (high importance, decayed salience) before assembleMemoryDigest runs.
  const mems = await db
    .select()
    .from(memoryNodes)
    .where(eq(memoryNodes.sessionId, id))
    .orderBy(desc(sql`${memoryNodes.importance} * 0.7 + ${memoryNodes.salience} * 0.3`))
    .limit(60);
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd e:\Projects\RPG_arena && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sessions/[id]/act/route.ts
git commit -m "fix: memory query uses weighted rank (importance*0.7 + salience*0.3) to prevent NPC eviction"
```

---

### Task 4: responseSchema + JSON Parse Hardening

**Files:**
- Modify: `src/lib/gemini.ts`
- Modify: `src/app/api/sessions/[id]/act/route.ts`

**Context:** Gemini v1beta supports `responseMimeType: "application/json"` and `responseSchema` in `generationConfig`. When set, API guarantees clean JSON without markdown wrappers. Current indexOf/lastIndexOf parsing breaks when narration contains `}`.

- [ ] **Step 1: Add `responseSchema` parameter to `callGeminiWithRotation` in `gemini.ts`**

Find the function signature at line 255-262 in `src/lib/gemini.ts`:
```ts
export async function callGeminiWithRotation(opts: {
  keys: string[];
  models: string[];
  system: string;
  user: string;
  maxTokens?: number;
  onAttempt?: (info: { model: string; keyIndex: number; ok: boolean; latencyMs: number; error?: string }) => Promise<void> | void;
}): Promise<{ text: string; model: string; keyIndex: number; latencyMs: number }> {
```

Replace with:
```ts
export async function callGeminiWithRotation(opts: {
  keys: string[];
  models: string[];
  system: string;
  user: string;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  onAttempt?: (info: { model: string; keyIndex: number; ok: boolean; latencyMs: number; error?: string }) => Promise<void> | void;
}): Promise<{ text: string; model: string; keyIndex: number; latencyMs: number }> {
```

Find the `generationConfig` block in the fetch body (lines ~276-280):
```ts
            generationConfig: {
              temperature: 0.85,
              maxOutputTokens: opts.maxTokens ?? 1200,
            },
```

Replace with:
```ts
            generationConfig: {
              temperature: 0.85,
              maxOutputTokens: opts.maxTokens ?? 1200,
              ...(opts.responseSchema
                ? {
                    responseMimeType: "application/json",
                    responseSchema: opts.responseSchema,
                  }
                : {}),
            },
```

- [ ] **Step 2: Add `RESOLUTION_RESPONSE_SCHEMA` export to `gemini.ts`**

After `buildResolutionSystemPrompt` function (after line ~222), add:

```ts
/** JSON Schema for structured output of resolution task responses. */
export const RESOLUTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["success", "partial", "failure"] },
    dc: { type: "number" },
    roll_reason: { type: "string" },
    narration: { type: "string" },
    effects: {
      type: "object",
      properties: {
        hp: { type: "number" },
        xp: { type: "number" },
        gold: { type: "number" },
        flags: { type: "object" },
      },
      required: ["hp", "xp", "gold"],
    },
    loot: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "kind", "description"],
      },
    },
    choices: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["outcome", "narration", "effects", "choices"],
};
```

- [ ] **Step 3: Import `RESOLUTION_RESPONSE_SCHEMA` in `act/route.ts`**

Find the import from `@/lib/gemini` (lines 5-14) in `act/route.ts`:
```ts
import {
  buildNarrationSystemPrompt,
  buildResolutionSystemPrompt,
  callGeminiWithRotation,
  estimateTokens,
  isLite,
  routeModelsFor,
  RoutingConfig,
  TaskType,
} from "@/lib/gemini";
```

Replace with:
```ts
import {
  buildNarrationSystemPrompt,
  buildResolutionSystemPrompt,
  callGeminiWithRotation,
  estimateTokens,
  isLite,
  routeModelsFor,
  RoutingConfig,
  TaskType,
  RESOLUTION_RESPONSE_SCHEMA,
} from "@/lib/gemini";
```

- [ ] **Step 4: Pass `responseSchema` in `callGeminiWithRotation` call**

Find `callGeminiWithRotation` call in act/route.ts (lines ~208-226):
```ts
      const res = await callGeminiWithRotation({
        keys: aiConf.keys,
        models,
        system,
        user,
        maxTokens: 1400,
        onAttempt: async (a) => {
```

Replace with:
```ts
      const res = await callGeminiWithRotation({
        keys: aiConf.keys,
        models,
        system,
        user,
        maxTokens: 1400,
        ...(isCustom ? { responseSchema: RESOLUTION_RESPONSE_SCHEMA } : {}),
        onAttempt: async (a) => {
```

- [ ] **Step 5: Harden JSON parsing in resolution block**

Find the resolution JSON parse block (lines ~234-261):
```ts
      if (isCustom) {
        // Парсинг JSON для свободных действий
        try {
          const jsonStart = res.text.indexOf("{");
          const jsonEnd = res.text.lastIndexOf("}");
          if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
            throw new Error("NO_JSON");
          }
          const jsonStr = res.text.slice(jsonStart, jsonEnd + 1);
          const parsed = JSON.parse(jsonStr);
```

Replace with:
```ts
      if (isCustom) {
        // Парсинг JSON для свободных действий.
        // С responseSchema API возвращает чистый JSON без обёрток.
        // Fallback indexOf/lastIndexOf для старых моделей без схемы.
        try {
          let jsonStr = res.text.trim();
          if (!jsonStr.startsWith("{")) {
            const jsonStart = jsonStr.indexOf("{");
            const jsonEnd = jsonStr.lastIndexOf("}");
            if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
              throw new Error("NO_JSON");
            }
            jsonStr = jsonStr.slice(jsonStart, jsonEnd + 1);
          }
          const parsed = JSON.parse(jsonStr);
```

- [ ] **Step 6: Verify TypeScript**

```bash
cd e:\Projects\RPG_arena && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/gemini.ts src/app/api/sessions/[id]/act/route.ts
git commit -m "feat: responseSchema for resolution calls + harden JSON parsing (startsWith check)"
```

---

### Task 5: Dice Before AI (Resolution Refactor)

**Files:**
- Modify: `src/lib/engine.ts` (export `detectSkill`)
- Modify: `src/lib/gemini.ts` (update `buildResolutionSystemPrompt` signature)
- Modify: `src/app/api/sessions/[id]/act/route.ts` (pre-roll logic + prompt update)

**Context (critical — read before implementing):**

Current flow (broken): AI receives action → generates narration + outcome → dice rolled AFTER → mismatch corrected only for one case.

Required flow: parse action → detect skill → compute modifier → rollD20 → pass result to AI prompt as FACT → AI writes narration knowing the outcome → `dice` in response is the pre-rolled result, not re-rolled.

- [ ] **Step 1: Export `detectSkill` from `engine.ts`**

Find line 58 in `src/lib/engine.ts`:
```ts
function detectSkill(action: string): { skill: string; stat: string } {
```

Replace with:
```ts
export function detectSkill(action: string): { skill: string; stat: string } {
```

- [ ] **Step 2: Update `buildResolutionSystemPrompt` signature in `gemini.ts`**

Find and replace the entire `buildResolutionSystemPrompt` function (lines 186-222 in gemini.ts):

```ts
export function buildResolutionSystemPrompt(opts?: {
  tone?: string;
  worldName?: string;
  diceContext?: {
    skill: string;
    d20: number;
    modifier: number;
    total: number;
    dc: number;
    success: boolean;
    critical: string | null;
  };
}): string {
  const ctx = opts?.tone
    ? `Тон: ${opts.tone}. Мир: ${opts.worldName ?? "авторский"}.`
    : "";

  const diceBlock = opts?.diceContext
    ? (() => {
        const d = opts.diceContext!;
        const outcomeRu =
          d.critical === "crit"
            ? "КРИТИЧЕСКИЙ УСПЕХ (d20=20)"
            : d.critical === "fumble"
              ? "КРИТИЧЕСКАЯ НЕУДАЧА (d20=1)"
              : d.success
                ? `УСПЕХ (${d.total} ≥ DC ${d.dc})`
                : `НЕУДАЧА (${d.total} < DC ${d.dc})`;
        return `\nРЕЗУЛЬТАТ БРОСКА (факт, не меняй):\n· Навык: ${d.skill}\n· d20=${d.d20}${d.modifier >= 0 ? "+" : ""}${d.modifier} = ${d.total} vs DC ${d.dc}\n· Исход: ${outcomeRu}\n\nНарратив ОБЯЗАН соответствовать исходу выше. Если УСПЕХ — герой добивается цели (полностью или частично). Если НЕУДАЧА — цель не достигнута, возникают последствия. Не противоречь факту броска.`;
      })()
    : "";

  return `Ты — движок разрешения свободных действий (Action Resolution Engine). ${ctx}
Игрок совершает свободное авторское действие.${diceBlock}

Оцени реалистичность с учётом сеттинга, статов персонажа, инвентаря, сложности (DC) и памяти.

ВАЖНО о предметах:
· Игрок может взаимодействовать с ЛЮБЫМ объектом, который логично существует в сцене или мире.
· Предметы не ограничены заранее сгенерированным списком — если игрок подбирает камень, разбирает мышку, покупает семена, это всё валидно.
· Лут генерируй строго под сеттинг (современность → бытовые вещи; фэнтези → артефакты; sci-fi → техника).
· Если действие физически невозможно или нарушает канон — логично проваливай.

Верни СТРОГО валидный JSON:
{
  "outcome": "success" | "partial" | "failure",
  "dc": ${opts?.diceContext?.dc ?? 12},
  "roll_reason": "навык",
  "narration": "120-200 слов художественного описания последствий на русском во втором лице",
  "effects": {
    "hp": 0,
    "xp": 25,
    "gold": 0,
    "flags": {}
  },
  "loot": [
    { "name": "Название предмета", "kind": "misc", "description": "Краткое описание" }
  ],
  "choices": ["Вариант 1", "Вариант 2", "Вариант 3"]
}
Никакого текста вне JSON.`;
}
```

- [ ] **Step 3: Add `detectSkill` import in `act/route.ts`**

Find import from `@/lib/engine`:
```ts
import { runOfflineEngine } from "@/lib/engine";
```

Replace with:
```ts
import { runOfflineEngine, detectSkill } from "@/lib/engine";
```

Find import from `@/lib/dice`:
```ts
import { rollD20, dcFor } from "@/lib/dice";
```

Replace with:
```ts
import { rollD20, dcFor, statModifier } from "@/lib/dice";
```

- [ ] **Step 4: Add pre-roll block before `if (canUseLive)` in `act/route.ts`**

Find the block around lines 172-186 (after effects/flags declarations, before `canUseLive` check):
```ts
  const charLine = `${character.name} (${character.archetype}...
  const worldLine = `Мир ${world.worldName}...

  if (canUseLive) {
```

Insert the pre-roll block BETWEEN `worldLine` and `if (canUseLive)`:
```ts
  const charLine = `${character.name} (${character.archetype}, ур.${character.level}, HP ${character.hp}/${character.maxHp}, статы ${Object.entries(character.stats).map(([k, v]) => `${k}:${v}`).join(" ")}, навыки: ${character.skills.join(", ")}, золото ${character.gold})`;
  const worldLine = `Мир ${world.worldName}, тон: ${world.tone ?? "приключенческий"}, квест: ${world.mainQuest}, глава ${world.chapter}, накал ${world.danger}`;

  // ── Предварительный бросок для resolution (кубик до AI) ──
  // Для isCustom: бросаем d20 до вызова AI, передаём результат в промпт как факт.
  // AI видит исход броска и пишет нарратив под него, не может противоречить.
  let preRolledDice: typeof dice = null;
  if (isCustom) {
    const { skill, stat } = detectSkill(playerAction);
    const statScore = (character.stats as Record<string, number>)[stat] ?? 11;
    const mod = statModifier(statScore);
    const dc = dcFor(world.danger, nextTurn);
    preRolledDice = { ...rollD20(skill, mod, dc) };
  }

  if (canUseLive) {
```

- [ ] **Step 5: Update `buildResolutionSystemPrompt` call to pass `diceContext`**

Find the `system` variable assignment in `if (canUseLive)` block (lines ~190-199):
```ts
      const system = isCustom
        ? buildResolutionSystemPrompt({ tone: world.tone, worldName: world.worldName })
        : buildNarrationSystemPrompt({
```

Replace with:
```ts
      const system = isCustom
        ? buildResolutionSystemPrompt({
            tone: world.tone,
            worldName: world.worldName,
            diceContext: preRolledDice
              ? {
                  skill: preRolledDice.skill,
                  d20: preRolledDice.d20,
                  modifier: preRolledDice.modifier,
                  total: preRolledDice.total,
                  dc: preRolledDice.dc,
                  success: preRolledDice.success,
                  critical: preRolledDice.critical,
                }
              : undefined,
          })
        : buildNarrationSystemPrompt({
```

- [ ] **Step 6: Replace post-AI dice roll with preRolledDice in resolution parse block**

In the resolution JSON parse block (inside `if (isCustom)` try block), find these lines (from Task 4's updated version):
```ts
          const dc = Number(parsed.dc ?? dcFor(world.danger, nextTurn));
          const skillGuess = String(parsed.roll_reason ?? "Выживание").slice(0, 40);
          dice = { ...rollD20(skillGuess, 1, dc) };
          if (dice.success && parsed.outcome === "failure") {
            narration += " (Кости, однако, благоволят тебе — удача переламывает исход!)";
          }
```

Replace with:
```ts
          // Используем уже брошенный preRolledDice — кубик брошен ДО AI.
          // Нарратив написан под известный исход, корректирующей фразы не нужно.
          dice = preRolledDice;
```

- [ ] **Step 7: Verify TypeScript**

```bash
cd e:\Projects\RPG_arena && npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/engine.ts src/lib/gemini.ts src/app/api/sessions/[id]/act/route.ts
git commit -m "fix!: roll dice before AI for resolution tasks — eliminates AI yes-manning"
```

---

## Verification Plan

### After each task
```bash
cd e:\Projects\RPG_arena && npx tsc --noEmit
```

### After all tasks — manual smoke test
1. `npm run dev`
2. Create session, perform free-form action (live AI)
3. Verify: dice shown, narration matches outcome, no "(Кости благоволят...)" correction phrases
4. Rapid double-click on choice button — verify no duplicate requests

