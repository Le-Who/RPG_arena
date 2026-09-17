// ── Оркестратор хода (RES-1f): контекст → проверка → AI/offline → reducers → транзакция → фон ──
import { after } from "next/server";
import { and, asc, count, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  gameSessions,
  gameTurns,
  inventoryItems,
  memoryNodes,
  npcs,
  quests,
  sceneObjects,
  worldLocations,
  type AppliedChanges,
  type CharacterState,
  type DiceResult,
  type TurnContextMeta,
  type WorldState,
} from "@/db/schema";
import {
  buildDiceBlock,
  buildExtractionSystemPrompt,
  buildTurnSystemPrompt,
  buildTurnUserPrompt,
  callGeminiWithRotation,
  estimateTokens,
  EXTRACTION_RESPONSE_SCHEMA,
  isLite,
  RESOLUTION_RESPONSE_SCHEMA,
  type TaskType,
} from "./gemini";
import { getAIConfig, logToken, pickModels, type AIConfig } from "./ai-settings";
import { assembleMemoryDigest, layerForFactType, LAYER_INFO, loadRankedNodes, normalizeExtractedFacts, shouldCompact, upsertMemoryNode, writeStateEvents, type ModelTier } from "./memory";
import { enqueueEmbeddings, indexPendingEmbeddings, retrievedDigest, searchMemory, type RetrievedNode } from "./embeddings";
import { applyResolution, emptyChanges, extractJsonObject, parseResolution, type DbOp, type ResolutionPayload } from "./resolution";
import { profileFor } from "./profiles";
import { runOfflineEngine, serverCheck } from "./engine";
import { SCENARIOS } from "./scenarios";

export type TurnResponse = {
  ok: true;
  turnNumber: number;
  narration: string;
  choices: string[];
  dice: DiceResult | null;
  outcome: string;
  applied: AppliedChanges;
  modelUsed: string;
  taskType: TaskType;
  needsCompaction: boolean;
  dead: boolean;
  retrieved: { id: string; title: string; why: string }[];
  skippedModels: string[];
  warnings: string[];
  replay?: boolean;
};

export type TurnError = { ok: false; code: "NOT_FOUND" | "AI_REQUIRED" | "AI_FAILED" | "BUSY"; message: string; details?: string };

const short = (id: string) => id.slice(0, 6);

export function buildCharacterLine(c: CharacterState, rulesProfile: string): string {
  const spec = profileFor(rulesProfile);
  const conds = c.conditions?.length ? `, состояния: ${c.conditions.join(", ")}` : "";
  const skills = c.skills?.length ? `, навыки: ${c.skills.join(", ")}` : "";
  const traits = c.traits?.length ? `, черты: ${c.traits.join(", ")}` : "";
  if (spec.id === "d20") {
    return `${c.name} (${c.archetype}, ур.${c.level}, HP ${c.hp}/${c.maxHp}, статы ${Object.entries(c.stats ?? {}).map(([k, v]) => `${k}:${v}`).join(" ")}${skills}${traits}, средства ${c.gold}${conds})`;
  }
  if (spec.id === "rules-light") {
    return `${c.name} (${c.archetype}, состояние ${c.hp}/${c.maxHp}, средства ${c.gold}${skills}${traits}${conds})`;
  }
  return `${c.name} (${c.archetype}${traits}${skills}${conds})`;
}

function buildDigests(input: {
  inventory: { id: string; name: string; kind: string; quantity: number; equipped: boolean; description: string }[];
  questRows: { key: string; title: string; status: string; progress: number; isMain: boolean; description: string }[];
  npcRows: { key: string; name: string; role: string; relation: number; status: string; description: string }[];
  scene: { key: string; name: string; state: string; description: string; locationName: string }[];
  location: string;
}) {
  const inv = [...input.inventory].sort((a, b) => Number(b.kind === "quest") - Number(a.kind === "quest") || Number(b.equipped) - Number(a.equipped));
  const inventoryDigest = inv.length
    ? inv.slice(0, 14).map((i) => `#${short(i.id)} ${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""} (${i.kind}${i.equipped ? ", надето" : ""})${i.description ? ` — ${i.description.slice(0, 70)}` : ""}`).join("; ") + (inv.length > 14 ? `; … ещё ${inv.length - 14}` : "")
    : "пусто";
  const active = input.questRows.filter((q) => q.status === "active" || q.status === "hidden");
  const done = input.questRows.filter((q) => q.status === "completed" || q.status === "failed");
  const questsDigest =
    (active.length ? active.slice(0, 8).map((q) => `${q.key}: «${q.title}»${q.isMain ? " (главная)" : ""} ${q.progress}%${q.description ? ` — ${q.description.slice(-120)}` : ""}`).join("; ") : "нет активных целей") +
    (done.length ? `. Закрытые: ${done.slice(-4).map((q) => `${q.key} (${q.status === "completed" ? "выполнен" : "провален"})`).join(", ")}` : "");
  const npcsDigest = input.npcRows.length
    ? input.npcRows.slice(0, 12).map((n) => `${n.key}: ${n.name}${n.role ? ` (${n.role})` : ""}, отношение ${n.relation > 0 ? "+" : ""}${n.relation}${n.status !== "alive" ? `, ${n.status}` : ""}${n.description ? ` — ${n.description.slice(-90)}` : ""}`).join("; ")
    : "пока никого";
  const here = input.scene.filter((o) => o.locationName.toLowerCase() === input.location.toLowerCase());
  const sceneDigest = here.length ? here.slice(0, 10).map((o) => `${o.key}: ${o.name} [${o.state}]${o.description ? ` — ${o.description.slice(0, 60)}` : ""}`).join("; ") : "не зафиксированы";
  return { inventoryDigest, questsDigest, npcsDigest, sceneDigest };
}

async function loadReplay(sessionId: string, requestId: string): Promise<TurnResponse | null> {
  const p = await db
    .select({ turnNumber: gameTurns.turnNumber })
    .from(gameTurns)
    .where(and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.requestId, requestId)))
    .limit(1);
  if (!p[0]) return null;
  const n = await db
    .select()
    .from(gameTurns)
    .where(and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.turnNumber, p[0].turnNumber), eq(gameTurns.role, "narrator")))
    .limit(1);
  if (!n[0]) return null;
  return {
    ok: true,
    replay: true,
    turnNumber: n[0].turnNumber,
    narration: n[0].content,
    choices: n[0].choices ?? [],
    dice: (n[0].dice as DiceResult | null) ?? null,
    outcome: "replay",
    applied: (n[0].stateChanges as AppliedChanges | null) ?? emptyApplied(),
    modelUsed: n[0].modelUsed ?? "",
    taskType: (n[0].taskType as TaskType) ?? "narration",
    needsCompaction: false,
    dead: Boolean(n[0].stateChanges?.dead),
    retrieved: [],
    skippedModels: [],
    warnings: ["replay: повторный запрос с тем же requestId"],
  };
}

export function emptyApplied(): AppliedChanges {
  return { hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [] };
}

export async function performTurn(opts: { sessionId: string; action: string; isFree: boolean; requestId?: string | null }): Promise<TurnResponse | TurnError> {
  const { sessionId } = opts;
  const playerAction = opts.action.trim().slice(0, 2000) || "Осмотреться";
  const requestId = opts.requestId?.slice(0, 80) || null;

  if (requestId) {
    const replay = await loadReplay(sessionId, requestId);
    if (replay) return replay;
  }

  const sRows = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (!sRows[0]) return { ok: false, code: "NOT_FOUND", message: "Кампания не найдена" };
  const session = sRows[0];
  const character: CharacterState = { conditions: [], ...(session.character as CharacterState) };
  const world = session.worldState as WorldState;
  const spec = profileFor(session.rulesProfile);
  const campaignMode = session.campaignMode ?? (session.scenarioId === "custom" ? "free" : "preset");
  const cfg = await getAIConfig();

  // ARCH-1d: свободная кампания — AI-first, без офлайн-шаблона
  if (campaignMode === "free" && !cfg.canUseLive) {
    return {
      ok: false,
      code: "AI_REQUIRED",
      message: cfg.keys.length ? "Live Gemini выключен: включите его в настройках — свободная кампания ведётся только ИИ-мастером." : "Для свободной кампании нужен ключ Gemini: добавьте его в настройках.",
    };
  }

  const taskType: TaskType = opts.isFree ? "resolution" : "narration";
  const { models, skipped } = cfg.canUseLive ? await pickModels(taskType, cfg) : { models: [], skipped: [] };
  const primaryModel = models[0] ?? "gemini-3.5-flash-lite";
  const tier: ModelTier = isLite(primaryModel) ? "lite" : "flash";
  const recentCount = tier === "flash" ? 16 : 10;
  const recentCharLimit = tier === "flash" ? 1500 : 1000;

  const [recentRaw, mems, inventory, questRows, npcRows, scene, locations] = await Promise.all([
    db.select().from(gameTurns).where(eq(gameTurns.sessionId, sessionId)).orderBy(desc(gameTurns.turnNumber), desc(gameTurns.createdAt)).limit(recentCount),
    loadRankedNodes(sessionId, 60),
    db.select().from(inventoryItems).where(eq(inventoryItems.sessionId, sessionId)).orderBy(asc(inventoryItems.createdAt)),
    db.select().from(quests).where(eq(quests.sessionId, sessionId)).orderBy(asc(quests.createdAt)),
    db.select().from(npcs).where(eq(npcs.sessionId, sessionId)).orderBy(desc(npcs.lastSeenTurn)),
    db.select().from(sceneObjects).where(eq(sceneObjects.sessionId, sessionId)),
    db.select().from(worldLocations).where(eq(worldLocations.sessionId, sessionId)),
  ]);
  const recent = [...recentRaw].reverse();
  const recentTurns = recent.map((t) => `[${t.role} #${t.turnNumber}]: ${t.content.slice(0, recentCharLimit)}`).join("\n");
  const lastNarration = [...recent].reverse().find((t) => t.role === "narrator")?.content.slice(0, 240) ?? "";
  const nextTurn = (session.turnCount ?? 0) + 1;

  // ── Серверная проверка по профилю — ДО вызова AI ──
  const dice: DiceResult | null = opts.isFree
    ? serverCheck({ rulesProfile: spec.id, playerAction, stats: character.stats ?? {}, danger: world.danger, turnCount: nextTurn })
    : null;

  // ── Семантический поиск памяти (MEM-2e) ──
  let retrieved: RetrievedNode[] = [];
  let retrievalMs = 0;
  const warnings: string[] = [];
  if (cfg.canUseLive && cfg.embeddingsEnabled && mems.length > 6) {
    try {
      const r = await searchMemory({
        sessionId,
        query: `${playerAction}. Локация: ${world.currentLocation}. ${lastNarration}`,
        keys: cfg.keys,
        model: cfg.embeddingModel,
        dims: cfg.embeddingDims,
        k: 8,
        currentTurn: nextTurn,
      });
      retrieved = r.results;
      retrievalMs = r.ms;
    } catch (e) {
      warnings.push(`retrieval: ${e instanceof Error ? e.message.slice(0, 80) : "err"}`);
    }
  }
  const retrievedIds = new Set(retrieved.map((r) => r.id));
  const memoryDigest = assembleMemoryDigest(
    mems.map((m) => ({ id: m.id, layer: m.layer, title: m.title, content: m.content, importance: m.importance, salience: m.salience, turnTo: m.turnTo ?? undefined })),
    tier,
    nextTurn,
    retrievedIds,
  );
  const digests = buildDigests({ inventory, questRows, npcRows, scene, location: world.currentLocation });
  const characterLine = buildCharacterLine(character, spec.id);
  const worldLine = `Мир ${world.worldName}, тон: ${world.tone}, эпоха: ${world.era}, главная цель: ${world.mainQuest}, глава ${world.chapter}, накал ${world.danger}/100${world.factions?.length ? `, фракции: ${world.factions.join(", ")}` : ""}`;

  let payload: ResolutionPayload | null = null;
  let modelUsed = "offline-engine";
  let promptTokens = 0;
  let completionTokens = 0;

  if (cfg.canUseLive && models.length) {
    const ctx = {
      mode: opts.isFree ? ("free" as const) : ("choice" as const),
      campaignMode,
      profileCanon: spec.promptCanon,
      tone: world.tone,
      worldName: world.worldName,
      scenarioPrompt: session.scenarioPrompt.slice(0, 1400),
      characterLine,
      worldLine,
      location: world.currentLocation,
      ...digests,
      memoryDigest,
      retrievedDigest: retrievedDigest(retrieved),
      recentTurns,
      diceBlock: buildDiceBlock(dice),
      playerAction,
    };
    const system = buildTurnSystemPrompt(ctx);
    const user = buildTurnUserPrompt(ctx);
    try {
      const res = await callGeminiWithRotation({
        keys: cfg.keys,
        models,
        system,
        user,
        maxTokens: tier === "flash" ? 2200 : 1800,
        temperature: 0.8,
        responseSchema: RESOLUTION_RESPONSE_SCHEMA,
        onAttempt: async (a) => {
          if (!a.ok) await logToken({ sessionId, model: a.model, taskType, promptTokens: 0, completionTokens: 0, latencyMs: a.latencyMs, success: false, error: a.error, keyIndex: a.keyIndex });
        },
      });
      modelUsed = res.model;
      promptTokens = res.promptTokens;
      completionTokens = res.completionTokens;
      const parsed = parseResolution(res.text);
      payload = parsed.payload;
      warnings.push(...parsed.warnings);
      await logToken({ sessionId, model: res.model, taskType, promptTokens, completionTokens, latencyMs: res.latencyMs, success: true, keyIndex: res.keyIndex });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (campaignMode === "free") {
        return { ok: false, code: "AI_FAILED", message: "ИИ-мастер сейчас недоступен. Ход не записан — повторите через минуту.", details: msg.slice(0, 200) };
      }
      warnings.push(`live fallback: ${msg.slice(0, 100)}`);
    }
  } else if (cfg.canUseLive && !models.length) {
    if (campaignMode === "free") {
      return { ok: false, code: "AI_FAILED", message: "Все модели исчерпали дневной лимит. Отключите enforceLimits в настройках или подождите до завтра.", details: `skipped: ${skipped.join(", ")}` };
    }
    warnings.push("все модели исчерпали лимит — офлайн-движок пресета");
  }

  if (!payload) {
    // ARCH-1d: офлайн-движок только для preset
    if (campaignMode !== "preset") return { ok: false, code: "AI_REQUIRED", message: "Свободная кампания требует ИИ-мастера." };
    const preset = SCENARIOS.find((s) => s.id === session.scenarioId);
    const eng = runOfflineEngine({
      playerAction,
      isFreeAction: opts.isFree,
      rulesProfile: spec.id,
      character: { name: character.name, archetype: character.archetype, stats: character.stats ?? {}, hp: character.hp, maxHp: character.maxHp },
      world: { worldName: world.worldName, currentLocation: world.currentLocation, mainQuest: world.mainQuest, danger: world.danger, chapter: world.chapter, tone: world.tone },
      turnCount: nextTurn,
      scenarioTitle: session.scenarioTitle,
      lootPool: preset?.lootPool,
    });
    modelUsed = cfg.canUseLive ? "offline-engine (fallback)" : "offline-engine";
    completionTokens = estimateTokens(eng.narration);
    promptTokens = estimateTokens(playerAction + memoryDigest);
    payload = {
      narration: eng.narration,
      outcome: eng.dice ? (eng.dice.success ? "success" : "failure") : "neutral",
      choices: eng.choices,
      effects: eng.effects,
      stateChanges: {
        ...emptyChanges(),
        inventory: eng.loot.map((l) => ({ op: "add" as const, ref: null, name: l.name, kind: l.kind, quantity: 1, description: l.description })),
        conditions: eng.conditions,
      },
    };
  }
  if (!payload.choices.length) payload.choices = ["Осмотреться внимательнее", "Заговорить с ближайшим персонажем", "Двигаться дальше"];

  // ── Reducers ──
  const result = applyResolution({
    rulesProfile: spec.id,
    campaignMode,
    character,
    world,
    inventory,
    quests: questRows,
    npcs: npcRows,
    sceneObjects: scene,
    locations,
    payload,
    dice,
    turnNumber: nextTurn,
  });
  const isChapterBoundary = nextTurn % 12 === 0;
  const contextMeta: TurnContextMeta = { model: modelUsed, rulesProfile: spec.id, digestChars: memoryDigest.length, retrievedIds: [...retrievedIds], retrievalMs, skippedModels: skipped };
  const narrationOut = result.applied.dead
    ? `${payload.narration}\n\n💀 ${character.name} на грани гибели. История не обрывается — но цена уплачена${spec.resources.gold ? " (−10 средств)" : ""}.`
    : payload.narration;

  // ── Транзакция (RES-1f): всё или ничего ──
  let touchedMemoryIds: string[] = [];
  try {
    touchedMemoryIds = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);
      await tx.insert(gameTurns).values({
        sessionId,
        turnNumber: nextTurn,
        role: "player",
        content: playerAction,
        choices: [],
        taskType,
        modelUsed: "player",
        promptTokens: 0,
        completionTokens: estimateTokens(playerAction),
        requestId,
      });
      await tx
        .update(gameSessions)
        .set({
          character: result.character,
          worldState: { ...result.world, chapter: isChapterBoundary ? world.chapter + 1 : world.chapter },
          turnCount: nextTurn,
          contextTokensEstimate: promptTokens,
          updatedAt: new Date(),
        })
        .where(eq(gameSessions.id, sessionId));
      await tx.insert(gameTurns).values({
        sessionId,
        turnNumber: nextTurn,
        role: "narrator",
        content: narrationOut,
        choices: payload!.choices,
        dice,
        modelUsed,
        taskType,
        promptTokens,
        completionTokens,
        stateChanges: result.applied,
        contextMeta,
      });
      await executeOps(tx, sessionId, result.ops, nextTurn);
      const touched = await writeStateEvents(sessionId, result.events, nextTurn, tx);
      if (isChapterBoundary) {
        const r = await upsertMemoryNode(
          {
            sessionId,
            layer: "chronicle",
            category: "event",
            title: `Глава ${world.chapter} завершена (ход ${nextTurn})`,
            content: `[Итог главы ${world.chapter}] ${payload!.narration.slice(0, 460)}`,
            importance: 90,
            source: "state",
            sourceTurn: nextTurn,
            entityKey: `chapter:${world.chapter}`,
            mode: "upsert",
            turnFrom: Math.max(1, nextTurn - 11),
            turnTo: nextTurn,
          },
          tx,
        );
        if (r.changed) touched.push(r.id);
      }
      return touched;
    });
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "23505" && requestId) {
      const replay = await loadReplay(sessionId, requestId);
      if (replay) return replay;
    }
    throw e;
  }

  // ── Компакция? ──
  const lastCompactTurn = session.lastCompactTurn ?? 0;
  const playerCount = await db
    .select({ c: count() })
    .from(gameTurns)
    .where(and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.role, "player"), gt(gameTurns.turnNumber, lastCompactTurn)));
  const needsCompaction = shouldCompact(playerCount[0]?.c ?? 0, 0, estimateTokens(recentTurns), tier === "flash" ? 8000 : LAYER_INFO.working.budget);

  // ── Фон (MEM-1d, MEM-2c): не блокируем ответ ──
  const narrationForExtraction = payload.narration;
  const knownDigest = memoryDigest.slice(0, 3000);
  schedule(async () => {
    const extra: string[] = [];
    if (cfg.canUseLive && cfg.semanticExtractionEnabled && modelUsed.startsWith("gemini")) {
      try {
        extra.push(...(await runSemanticExtraction({ sessionId, turnNumber: nextTurn, narration: narrationForExtraction, playerAction, cfg, profileCanon: spec.promptCanon, knownDigest })));
      } catch (e) {
        console.warn("[extract]", e instanceof Error ? e.message : e);
      }
    }
    if (cfg.canUseLive && cfg.embeddingsEnabled) {
      try {
        await enqueueEmbeddings(sessionId, [...touchedMemoryIds, ...extra], cfg.embeddingModel, cfg.embeddingDims);
        await indexPendingEmbeddings({ sessionId, keys: cfg.keys, model: cfg.embeddingModel, dims: cfg.embeddingDims, limit: 32 });
      } catch (e) {
        console.warn("[embed]", e instanceof Error ? e.message : e);
      }
    }
  });

  return {
    ok: true,
    turnNumber: nextTurn,
    narration: narrationOut,
    choices: payload.choices,
    dice,
    outcome: result.outcome,
    applied: result.applied,
    modelUsed,
    taskType,
    needsCompaction,
    dead: result.applied.dead,
    retrieved: retrieved.map((r) => ({ id: r.id, title: r.title, why: r.why })),
    skippedModels: skipped,
    warnings,
  };
}

function schedule(fn: () => Promise<void>) {
  try {
    after(fn);
  } catch {
    // вне request-scope (тесты/скрипты) — запускаем сразу, не дожидаясь
    void fn();
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function executeOps(tx: Tx, sessionId: string, ops: DbOp[], turnNumber: number) {
  for (const op of ops) {
    switch (op.t) {
      case "inv.insert":
        await tx.insert(inventoryItems).values({ sessionId, ...op.row });
        break;
      case "inv.update":
        await tx.update(inventoryItems).set(op.patch).where(and(eq(inventoryItems.id, op.id), eq(inventoryItems.sessionId, sessionId)));
        break;
      case "inv.delete":
        await tx.delete(inventoryItems).where(and(eq(inventoryItems.id, op.id), eq(inventoryItems.sessionId, sessionId)));
        break;
      case "quest.insert":
        await tx.insert(quests).values({ sessionId, updatedTurn: turnNumber, ...op.row }).onConflictDoNothing();
        break;
      case "quest.update":
        await tx.update(quests).set({ ...op.patch, updatedTurn: turnNumber }).where(and(eq(quests.id, op.id), eq(quests.sessionId, sessionId)));
        break;
      case "npc.insert":
        await tx.insert(npcs).values({ sessionId, lastSeenTurn: turnNumber, ...op.row }).onConflictDoNothing();
        break;
      case "npc.update": {
        const { role, description, ...rest } = op.patch;
        await tx
          .update(npcs)
          .set({ ...rest, ...(role ? { role } : {}), ...(description ? { description } : {}), lastSeenTurn: turnNumber })
          .where(and(eq(npcs.id, op.id), eq(npcs.sessionId, sessionId)));
        break;
      }
      case "scene.insert":
        await tx.insert(sceneObjects).values({ sessionId, updatedTurn: turnNumber, ...op.row }).onConflictDoNothing();
        break;
      case "scene.update": {
        const { description, ...rest } = op.patch;
        await tx.update(sceneObjects).set({ ...rest, ...(description ? { description } : {}), updatedTurn: turnNumber }).where(and(eq(sceneObjects.id, op.id), eq(sceneObjects.sessionId, sessionId)));
        break;
      }
      case "loc.insert":
        if (op.row.current) await tx.update(worldLocations).set({ current: false }).where(eq(worldLocations.sessionId, sessionId));
        await tx.insert(worldLocations).values({ sessionId, connectedTo: [], ...op.row });
        break;
      case "loc.setCurrent":
        await tx.update(worldLocations).set({ current: false }).where(eq(worldLocations.sessionId, sessionId));
        await tx.update(worldLocations).set({ current: true, discovered: true }).where(and(eq(worldLocations.id, op.id), eq(worldLocations.sessionId, sessionId)));
        break;
      case "loc.discover":
        await tx.update(worldLocations).set({ discovered: true }).where(and(eq(worldLocations.id, op.id), eq(worldLocations.sessionId, sessionId)));
        break;
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  MEM-1b/d: асинхронный, идемпотентный semantic-extractor
// ─────────────────────────────────────────────────────────────
export async function runSemanticExtraction(input: {
  sessionId: string;
  turnNumber: number;
  narration: string;
  playerAction: string;
  cfg: AIConfig;
  profileCanon: string;
  knownDigest: string;
}): Promise<string[]> {
  const existing = await db
    .select({ id: memoryNodes.id })
    .from(memoryNodes)
    .where(and(eq(memoryNodes.sessionId, input.sessionId), eq(memoryNodes.source, "ai-semantic"), eq(memoryNodes.sourceTurn, input.turnNumber)))
    .limit(1);
  if (existing[0]) return []; // уже извлекали для этого хода

  const { models } = await pickModels("fast", input.cfg);
  if (!models.length) return [];
  const res = await callGeminiWithRotation({
    keys: input.cfg.keys,
    models,
    system: buildExtractionSystemPrompt(input.profileCanon, input.knownDigest),
    user: `Действие игрока: ${input.playerAction}\n\nТекст хода:\n${input.narration}`,
    maxTokens: 900,
    temperature: 0.2,
    responseSchema: EXTRACTION_RESPONSE_SCHEMA,
    timeoutMs: 30_000,
    onAttempt: async (a) => {
      if (!a.ok) await logToken({ sessionId: input.sessionId, model: a.model, taskType: "fast", promptTokens: 0, completionTokens: 0, latencyMs: a.latencyMs, success: false, error: a.error, keyIndex: a.keyIndex });
    },
  });
  await logToken({ sessionId: input.sessionId, model: res.model, taskType: "fast", promptTokens: res.promptTokens, completionTokens: res.completionTokens, latencyMs: res.latencyMs, success: true, keyIndex: res.keyIndex });
  const facts = normalizeExtractedFacts(extractJsonObject(res.text), input.narration, input.playerAction);
  const ids: string[] = [];
  for (const f of facts) {
    const r = await upsertMemoryNode({
      sessionId: input.sessionId,
      layer: layerForFactType(f.type),
      category: f.type === "npc" ? "npc" : f.type === "character" ? "character" : f.type === "relationship" ? "npc" : f.type === "event" || f.type === "promise" ? "event" : "world",
      title: f.title,
      content: f.content,
      importance: f.importance,
      source: "ai-semantic",
      sourceTurn: input.turnNumber,
      entityKey: f.entityKey ? `${f.entityKey}` : null,
      mode: f.entityKey ? "upsert" : "append",
      confidence: f.confidence,
      evidence: f.evidence,
    });
    if (r.changed) ids.push(r.id);
  }
  return ids;
}
