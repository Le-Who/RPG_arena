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
  turnRequests,
  type AppliedChanges,
  type CharacterState,
  type DiceResult,
  type TurnContextMeta,
  type WorldState,
} from "@/db/schema";
import {
  buildDiceBlock,
  buildTurnSystemPrompt,
  buildTurnUserPrompt,
  callGeminiWithRotation,
  estimateTokens,
  isLite,
  RESOLUTION_RESPONSE_SCHEMA,
  type TaskType,
} from "./gemini";
import { getAIConfig, logToken, pickModels, type AIConfig } from "./ai-settings";
import { assembleMemoryDigest, LAYER_INFO, loadRankedNodes, shouldCompact, writeStateEvents, type ModelTier } from "./memory";
import { retrievedDigest, searchMemory, type RetrievedNode } from "./embeddings";
import { applyResolution, emptyChanges, parseResolution, type DbOp, type ResolutionPayload } from "./resolution";
import { profileFor } from "./profiles";
import { runOfflineEngine } from "./engine";
import { SCENARIOS } from "./scenarios";

import type { TurnInput, TurnResponse, TurnError, TurnErrorCode } from "./turn-contract";
export type { TurnResponse, TurnError } from "./turn-contract";
import { acquireTurn, normalizeTurnInput, assertTurnLease, completeTurnRequest, failTurnRequest, setTurnStage, type TurnLease } from "./turn-admission";
import { HttpError } from "./http";
import { enqueueSemanticJob } from "./memory-jobs";
import { runMemoryCycle } from "./background";
import { relevantInventory } from "./context-budget";
import { actionWithItemBindings } from "./item-bindings";
import { prewarmSessionChoices, buildMemoryQuery } from "./choice-prewarm";
import { executeLocationOp } from "./location-ops";
import { narrationPreview, type TurnEvent } from "./turn-stream";
import type { TurnTimings } from "./turn-contract";
import { performance } from "node:perf_hooks";

export type TurnRuntime = { loadAIConfig?: () => Promise<AIConfig>; onEvent?: (event: TurnEvent) => void; schedule?: (job: () => Promise<void>) => void };

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
  inventory: { id: string; name: string; kind: string; quantity: number; equipped: boolean; description: string; power?: number }[];
  questRows: { key: string; title: string; status: string; progress: number; isMain: boolean; description: string }[];
  npcRows: { key: string; name: string; role: string; relation: number; status: string; description: string }[];
  scene: { key: string; name: string; state: string; description: string; locationName: string }[];
  location: string;
  playerAction: string;
}) {
  const inv = relevantInventory(input.inventory, input.playerAction);
  const inventoryDigest = inv.length
    ? inv.slice(0, 14).map((i) => `#${short(i.id)} ${i.name} ×${i.quantity} (${i.kind}${i.equipped ? ", надето" : ""}${i.power ? `, сила свойства: ${i.power}` : ""})${i.description ? ` — ${i.description.slice(0, 70)}` : ""}`).join("; ") + (input.inventory.length > inv.length ? `; … ещё ${input.inventory.length - inv.length} предметов вне контекста` : "")
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

export function emptyApplied(): AppliedChanges {
  return { hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [] };
}

export async function performTurn(raw: TurnInput, runtime: TurnRuntime = {}): Promise<TurnResponse | TurnError> {
  const started = performance.now();
  const timings: TurnTimings = {};
  let lease: TurnLease | undefined;
  try {
    const opts = normalizeTurnInput(raw);
    const admitted = await acquireTurn(opts);
    if (admitted.kind === "replay") return admitted.result;
    lease = admitted.lease;
    timings.admissionMs = Math.round(performance.now() - started);
    const result = await performAdmittedTurn(opts, lease, runtime, timings, started);
    if (result.ok) {
      result.timings = { ...timings, serverMs: Math.round(performance.now() - started) };
      const savedLease = lease;
      const encoded = JSON.stringify(result.timings);
      (runtime.schedule ?? schedule)(async () => {
        // Complete timing includes COMMIT. Persist after sending without delaying the player.
        try {
          await db.update(turnRequests).set({ result: sql`jsonb_set(${turnRequests.result}, '{timings}', ${encoded}::jsonb)` }).where(and(eq(turnRequests.id, savedLease.id), eq(turnRequests.status, "completed")));
          await db.update(gameTurns).set({ contextMeta: sql`jsonb_set(coalesce(${gameTurns.contextMeta}, '{}'::jsonb), '{timings}', ${encoded}::jsonb)` }).where(and(eq(gameTurns.sessionId, savedLease.sessionId), eq(gameTurns.turnNumber, result.turnNumber), eq(gameTurns.role, "narrator")));
        } catch { /* timing is observational; the durable game result is already saved */ }
      });
    }
    if (!result.ok) await failTurnRequest(lease, result.code);
    return result;
  } catch (error) {
    if (lease) await failTurnRequest(lease, error instanceof HttpError ? error.code : "INTERNAL").catch(() => {});
    if (error instanceof HttpError) return { ok: false, code: error.code as TurnErrorCode, message: error.message, ...error.extra };
    throw error;
  }
}

async function performAdmittedTurn(opts: TurnInput & { requestId: string }, lease: TurnLease, runtime: TurnRuntime, timings: TurnTimings, started: number): Promise<TurnResponse | TurnError> {
  const contextStarted = performance.now();
  const emit = runtime.onEvent;
  emit?.({ type: "stage", stage: "context" });
  const sessionId = opts.sessionId;
  const playerAction = opts.action;
  const requestId = opts.requestId;
  const session = lease.session;
  const character: CharacterState = { conditions: [], ...(session.character as CharacterState) };
  const world = session.worldState as WorldState;
  const spec = profileFor(session.rulesProfile);
  const campaignMode = session.campaignMode ?? (session.scenarioId === "custom" ? "free" : "preset");
  const cfg = await (runtime.loadAIConfig ?? getAIConfig)();

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

  const [recentRaw, mems, inventory, questRows, npcRows, scene, locations, playerCount] = await Promise.all([
    db.select().from(gameTurns).where(eq(gameTurns.sessionId, sessionId)).orderBy(desc(gameTurns.turnNumber), desc(sql`case when ${gameTurns.role} = 'player' then 0 else 1 end`), desc(gameTurns.createdAt)).limit(recentCount),
    loadRankedNodes(sessionId, 60),
    db.select().from(inventoryItems).where(eq(inventoryItems.sessionId, sessionId)).orderBy(asc(inventoryItems.createdAt)),
    db.select().from(quests).where(eq(quests.sessionId, sessionId)).orderBy(asc(quests.createdAt)),
    db.select().from(npcs).where(eq(npcs.sessionId, sessionId)).orderBy(desc(npcs.lastSeenTurn)),
    db.select().from(sceneObjects).where(eq(sceneObjects.sessionId, sessionId)),
    db.select().from(worldLocations).where(eq(worldLocations.sessionId, sessionId)),
    db.select({ c: count() }).from(gameTurns).where(and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.role, "player"), gt(gameTurns.turnNumber, session.lastCompactTurn ?? 0))),
  ]);
  const actionForModel = actionWithItemBindings(playerAction, opts.itemIds, inventory);
  const recent = [...recentRaw].reverse();
  const recentTurns = recent.map((t) => `[${t.role} #${t.turnNumber}]: ${t.content.slice(0, recentCharLimit)}`).join("\n");
  const lastNarration = [...recent].reverse().find((t) => t.role === "narrator")?.content.slice(0, 240) ?? "";
  const nextTurn = (session.turnCount ?? 0) + 1;

  // ── Серверная проверка по профилю — ДО вызова AI ──
  const dice: DiceResult | null = lease.dice;

  timings.contextMs = Math.round(performance.now() - contextStarted);
  const retrievalStarted = performance.now();
  // ── Семантический поиск памяти (MEM-2e) ──
  let retrieved: RetrievedNode[] = [];
  let retrievalMs = 0;
  const warnings: string[] = [];
  if (cfg.canUseLive && cfg.embeddingsEnabled && mems.length > 6) {
    try {
      const r = await searchMemory({
        sessionId,
        query: buildMemoryQuery(playerAction, world.currentLocation, lastNarration),
        keys: cfg.keys,
        model: cfg.embeddingModel,
        dims: cfg.embeddingDims,
        k: 8,
        currentTurn: nextTurn,
        timeoutMs: 6000,
      });
      retrieved = r.results;
      retrievalMs = r.ms;
    } catch (e) {
      warnings.push(`retrieval: ${e instanceof Error ? e.message.slice(0, 80) : "err"}`);
    }
  }
  timings.retrievalMs = Math.round(performance.now() - retrievalStarted);
  const retrievedIds = new Set(retrieved.map((r) => r.id));
  const memoryDigest = assembleMemoryDigest(
    mems.map((m) => ({ id: m.id, layer: m.layer, title: m.title, content: m.content, importance: m.importance, salience: m.salience, turnTo: m.turnTo ?? undefined })),
    tier,
    nextTurn,
    retrievedIds,
  );
  const digests = buildDigests({ inventory, questRows, npcRows, scene, location: world.currentLocation, playerAction: actionForModel });
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
      locationsDigest: locations.filter(l => l.discovered).map(l => `${l.id}: ${l.name}${l.current ? " (здесь)" : ""}`).join("; "),
      memoryDigest,
      retrievedDigest: retrievedDigest(retrieved),
      recentTurns,
      diceBlock: buildDiceBlock(dice),
      playerAction: actionForModel,
    };
    const system = buildTurnSystemPrompt(ctx);
    const user = buildTurnUserPrompt(ctx);
    const generationStarted = performance.now();
    let streamedJson = "", preview = "";
    try {
      await setTurnStage(lease, "generation");
      emit?.({ type: "stage", stage: "generation" });
      const res = await callGeminiWithRotation({
        keys: cfg.keys,
        models,
        system,
        user,
        maxTokens: tier === "flash" ? 2200 : 1800,
        temperature: 0.8,
        responseSchema: RESOLUTION_RESPONSE_SCHEMA,
        timeoutMs: 30_000,
        onAttemptStart: () => { streamedJson = ""; preview = ""; emit?.({ type: "narration", text: "" }); },
        ...(emit ? { onText: (delta: string) => {
          streamedJson += delta;
          const next = narrationPreview(streamedJson);
          if (next !== preview) { preview = next; if (next && timings.firstTextMs === undefined) timings.firstTextMs = Math.round(performance.now() - started); emit({ type: "narration", text: next }); }
        } } : {}),
        onAttempt: async (a) => {
          timings.attempts = (timings.attempts ?? 0) + 1;
          if (!a.ok) await logToken({ sessionId, model: a.model, taskType, promptTokens: 0, completionTokens: 0, latencyMs: a.latencyMs, success: false, error: a.error, keyIndex: a.keyIndex });
        },
      });
      timings.generationMs = Math.round(performance.now() - generationStarted);
      timings.thoughtTokens = res.thoughtTokens; timings.cachedTokens = res.cachedTokens;
      modelUsed = res.model;
      promptTokens = res.promptTokens;
      completionTokens = res.completionTokens;
      const parsed = parseResolution(res.text);
      if (!parsed.parsedJson) throw new Error("INVALID_RESOLUTION_JSON");
      payload = parsed.payload;
      warnings.push(...parsed.warnings);
      await logToken({ sessionId, model: res.model, taskType, promptTokens, completionTokens, latencyMs: res.latencyMs, success: true, keyIndex: res.keyIndex });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (campaignMode === "free") {
        return { ok: false, code: "AI_FAILED", message: "ИИ-мастер сейчас недоступен. Ход не записан — повторите через минуту.", details: msg.slice(0, 200) };
      }
      emit?.({ type: "narration", text: "" });
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
      resolvedDice: dice,
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

  const validationStarted = performance.now();
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
  const contextMeta: TurnContextMeta = { timings, model: modelUsed, rulesProfile: spec.id, digestChars: memoryDigest.length, retrievedIds: [...retrievedIds], retrievalMs, skippedModels: skipped };
  const narrationOut = result.applied.dead
    ? `${payload.narration}\n\n💀 ${character.name} на грани гибели. История не обрывается — но цена уплачена${spec.resources.gold ? " (−10 средств)" : ""}.`
    : payload.narration;

  const needsCompaction = shouldCompact((playerCount[0]?.c ?? 0) + 1, 0, estimateTokens(recentTurns), tier === "flash" ? 8000 : LAYER_INFO.working.budget);
  const committedWorld = { ...result.world, chapter: isChapterBoundary ? world.chapter + 1 : world.chapter };
  const response: TurnResponse = { ok: true, playerAction, timings, state: { character: result.character, worldState: committedWorld }, requestId, turnNumber: nextTurn, narration: narrationOut, choices: payload.choices, dice, outcome: result.outcome, applied: result.applied, modelUsed, taskType, needsCompaction, dead: result.applied.dead, retrieved: retrieved.map((r) => ({ id: r.id, title: r.title, why: r.why })), skippedModels: skipped, warnings };
  timings.validationMs = Math.round(performance.now() - validationStarted);
  await setTurnStage(lease, "applying");
  emit?.({ type: "stage", stage: "applying" });
  const writesStarted = performance.now();

  // ── Транзакция (RES-1f): всё или ничего ──

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sessionId}))`);
      await assertTurnLease(tx, lease);
      const [fresh] = await tx.select({ turnCount: gameSessions.turnCount, status: gameSessions.status }).from(gameSessions).where(eq(gameSessions.id, sessionId));
      if (!fresh || fresh.turnCount !== session.turnCount || fresh.status !== "active") throw new HttpError(409, "STALE_TURN", "История изменилась до сохранения хода. Обновите сцену.");
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
          worldState: committedWorld,
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
      await writeStateEvents(sessionId, result.events, nextTurn, tx, { lockHeld: true, dims: cfg.embeddingDims, extra: isChapterBoundary ? [{
        sessionId, layer: "chronicle", category: "event", title: `Глава ${world.chapter} завершена (ход ${nextTurn})`,
        content: `[Итог главы ${world.chapter}] ${payload!.narration.slice(0, 460)}`, importance: 90, source: "compaction", sourceTurn: nextTurn,
        entityKey: `chapter:${world.chapter}`, mode: "upsert", turnFrom: Math.max(1, nextTurn - 11), turnTo: nextTurn,
      }] : [] });
      if (cfg.canUseLive && cfg.semanticExtractionEnabled && modelUsed.startsWith("gemini")) await enqueueSemanticJob(tx, { sessionId, turnNumber: nextTurn, payload: { narration: payload!.narration, playerAction, profileCanon: spec.promptCanon, knownDigest: memoryDigest.slice(0, 3000) } });
      timings.writesMs = Math.round(performance.now() - writesStarted);
      await completeTurnRequest(tx, lease, response);
    });
  } catch (error) { throw error; }
  (runtime.schedule ?? schedule)(() => prewarmSessionChoices(sessionId));
  (runtime.schedule ?? schedule)(async () => { try { await runMemoryCycle({ sessionId, source: "after" }); } catch { console.warn("[memory worker] tick failed; durable tasks remain queued"); } });
  return response;
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
      case "loc.setCurrent":
      case "loc.discover":
      case "loc.connect":
        await executeLocationOp(tx, sessionId, op);
        break;
    }
  }
}
