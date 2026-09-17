import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiSettings, gameSessions, gameTurns, inventoryItems, memoryNodes, tokenLogs } from "@/db/schema";
import { asc, desc, eq } from "drizzle-orm";
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
import { assembleMemoryDigest, extractMemoryCandidates, shouldCompact } from "@/lib/memory";
import type { ModelTier } from "@/lib/memory";
import { runOfflineEngine } from "@/lib/engine";
import { rollD20, dcFor } from "@/lib/dice";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function parseChoices(text: string, fallback: string[]): string[] {
  const m = text.match(/ВАРИАНТЫ:\s*([\s\S]+)/i);
  if (!m) return fallback;
  return m[1]
    .split(/\s*\|\s*/)
    .map((s) => s.replace(/^\d+\)\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function stripChoicesLine(text: string) {
  return text.replace(/ВАРИАНТЫ:\s*[\s\S]+$/i, "").trim();
}

async function getAI() {
  const rows = await db.select().from(aiSettings).where(eq(aiSettings.id, "global"));
  if (!rows[0]) {
    await db.insert(aiSettings).values({
      id: "global",
      keys: [],
      useLiveAI: false,
      routingProfile: "balanced",
      narrationModel: "gemini-3.5-flash-lite",
      customActionModel: "gemini-3.8-flash",
      compactionModel: "gemini-3.8-flash",
      fastTaskModel: "gemini-3.5-flash-lite",
    });
    return {
      keys: [] as string[],
      useLiveAI: false,
      routingConfig: {
        profile: "balanced" as const,
        narrationModel: "gemini-3.5-flash-lite",
        customActionModel: "gemini-3.8-flash",
        compactionModel: "gemini-3.8-flash",
        fastTaskModel: "gemini-3.5-flash-lite",
      },
    };
  }
  const s = rows[0];
  return {
    keys: ((s.keys as string[]) ?? []).filter(Boolean),
    useLiveAI: s.useLiveAI,
    routingConfig: {
      profile: (s.routingProfile as RoutingConfig["profile"]) ?? "balanced",
      narrationModel: s.narrationModel ?? "gemini-3.5-flash-lite",
      customActionModel: s.customActionModel ?? "gemini-3.8-flash",
      compactionModel: s.compactionModel ?? "gemini-3.8-flash",
      fastTaskModel: s.fastTaskModel ?? "gemini-3.5-flash-lite",
    },
  };
}

async function logToken(row: {
  sessionId: string;
  model: string;
  taskType: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  keyIndex?: number;
}) {
  await db.insert(tokenLogs).values({
    sessionId: row.sessionId,
    model: row.model,
    taskType: row.taskType,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.promptTokens + row.completionTokens,
    latencyMs: row.latencyMs,
    success: row.success,
    error: row.error ?? "",
    keyIndex: row.keyIndex ?? 0,
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const playerAction: string = String(body.action ?? "").slice(0, 2000) || "Осмотреться";
  const isCustom: boolean = Boolean(body.custom); // true = игрок написал своё действие руками; false = выбрал готовый вариант 1/2/3

  const sRows = await db.select().from(gameSessions).where(eq(gameSessions.id, id));
  if (!sRows[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  const session = sRows[0];
  const character = session.character as typeof session.character;
  const world = session.worldState as typeof session.worldState;

  const turns = await db.select().from(gameTurns).where(eq(gameTurns.sessionId, id)).orderBy(asc(gameTurns.turnNumber)).limit(500);
  const mems = await db.select().from(memoryNodes).where(eq(memoryNodes.sessionId, id)).orderBy(desc(memoryNodes.importance)).limit(60);

  // Определяем tier модели для данного хода, чтобы адаптировать размер контекста
  // Это делается до getAI(), используя признак isCustom как первичный индикатор
  // (финальный tier пересчитывается после getAI() ниже)
  const aiConf = await getAI();
  const canUseLive = aiConf.useLiveAI && aiConf.keys.length > 0;

  // Tier модели: flash для свободных действий (resolution), lite для стандартного нарратива
  const routingModels = routeModelsFor(isCustom ? "resolution" : "narration", aiConf.routingConfig);
  const primaryModel = routingModels[0] ?? "gemini-3.5-flash-lite";
  const modelTier: ModelTier = isLite(primaryModel) ? "lite" : "flash";

  // Адаптивное окно недавних ходов: lite — 10 ходов × 1000 симв, flash — 16 × 1500 симв
  const recentCount = modelTier === "flash" ? 16 : 10;
  const recentCharLimit = modelTier === "flash" ? 1500 : 1000;
  const recentTurns = turns
    .slice(-recentCount)
    .map((t) => `[${t.role} #${t.turnNumber}]: ${t.content.slice(0, recentCharLimit)}`)
    .join("\n");

  const memoryDigest = assembleMemoryDigest(
    mems.map((m) => ({ layer: m.layer, title: m.title, content: m.content, importance: m.importance, salience: m.salience })),
    modelTier,
  );


  const nextTurn = (session.turnCount ?? turns.length) + 1;

  // сохраняем ход игрока
  await db.insert(gameTurns).values({
    sessionId: id,
    turnNumber: nextTurn,
    role: "player",
    content: playerAction,
    choices: [],
    taskType: isCustom ? "resolution" : "narration",
    modelUsed: "player",
    promptTokens: 0,
    completionTokens: estimateTokens(playerAction),
  });



  let narration = "";
  let choices: string[] = [];
  let dice: { d20: number; modifier: number; total: number; dc: number; success: boolean; critical: string | null; skill: string; label: string } | null = null;
  let modelUsed = "offline-engine";
  const taskType: TaskType = isCustom ? "resolution" : "narration";
  let promptTokens = 0;
  let completionTokens = 0;
  let loot: { name: string; kind: string; description: string; icon: string }[] = [];
  let effects = { hp: 0, xp: 25, gold: 0, dangerDelta: 0 };
  let flags: Record<string, string | number | boolean> = {};

  const charLine = `${character.name} (${character.archetype}, ур.${character.level}, HP ${character.hp}/${character.maxHp}, статы ${Object.entries(character.stats).map(([k, v]) => `${k}:${v}`).join(" ")}, навыки: ${character.skills.join(", ")}, золото ${character.gold})`;
  const worldLine = `Мир ${world.worldName}, квест: ${world.mainQuest}, глава ${world.chapter}, накал ${world.danger}`;

  if (canUseLive) {
    try {
      const models = routeModelsFor(taskType, aiConf.routingConfig);
      const system = isCustom ? buildResolutionSystemPrompt() : buildNarrationSystemPrompt({
        character: charLine,
        worldDigest: `${worldLine}. Предыстория: ${session.scenarioPrompt.slice(0, 600)}`,
        memoryDigest,
        recentTurns,
        location: world.currentLocation,
      });
      const user = isCustom
        // recentTurns уже разово ограничен (16 ходов × 1500 симв) — не режем повторно
        ? `Ситуация:\n${recentTurns}\nДействие игрока (free-form): ${playerAction}\nПерсонаж: ${charLine}\nЛокация: ${world.currentLocation}`
        : `Ход ${nextTurn}. Персонаж: ${charLine}. Игрок выбрал: «${playerAction}». Опиши последствия и предоставь 3 новых варианта.`;
      promptTokens = estimateTokens(system + user);
      const started = Date.now();
      const res = await callGeminiWithRotation({
        keys: aiConf.keys,
        models,
        system,
        user,
        maxTokens: 1400,
        onAttempt: async (a) => {
          await logToken({
            sessionId: id,
            model: a.model,
            taskType: a.ok ? taskType : `${taskType}-retry`,
            promptTokens: a.ok ? promptTokens : 50,
            completionTokens: 0,
            latencyMs: a.latencyMs,
            success: a.ok,
            error: a.error ?? "",
            keyIndex: a.keyIndex,
          });
        },
      });
      modelUsed = res.model;
      const latency = Date.now() - started;
      completionTokens = estimateTokens(res.text);

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
          narration = String(parsed.narration ?? res.text).slice(0, 3000);
          choices = Array.isArray(parsed.choices) ? parsed.choices.slice(0, 3) : [];
          loot = Array.isArray(parsed.loot) ? parsed.loot.slice(0, 3) : [];
          effects = {
            hp: Number(parsed.effects?.hp ?? 0),
            xp: Number(parsed.effects?.xp ?? 25),
            gold: Number(parsed.effects?.gold ?? 0),
            dangerDelta: 0,
          };
          flags = parsed.effects?.flags ?? {};
          const dc = Number(parsed.dc ?? dcFor(world.danger, nextTurn));
          const skillGuess = String(parsed.roll_reason ?? "Выживание").slice(0, 40);
          dice = { ...rollD20(skillGuess, 1, dc) };
          if (dice.success && parsed.outcome === "failure") {
            narration += " (Кости, однако, благоволят тебе — удача переламывает исход!)";
          }
        } catch {
          narration = stripChoicesLine(res.text).slice(0, 3000) || res.text.slice(0, 3000);
          choices = parseChoices(res.text, []);
        }
      } else {
        narration = stripChoicesLine(res.text).slice(0, 3000) || res.text.slice(0, 3000);
        choices = parseChoices(res.text, []);
      }
      if (!choices.length) choices = ["Осмотреться внимательнее", "Заговорить с местными", "Двигаться дальше по следу"];
      await logToken({ sessionId: id, model: modelUsed, taskType, promptTokens, completionTokens, latencyMs: latency, success: true });
    } catch (e) {
      // Фолбэк на офлайн при исчерпании квот или ошибке сети
      const eng = runOfflineEngine({
        playerAction,
        character: { name: character.name, archetype: character.archetype, stats: character.stats, hp: character.hp, maxHp: character.maxHp },
        world: { worldName: world.worldName, currentLocation: world.currentLocation, mainQuest: world.mainQuest, danger: world.danger, chapter: world.chapter },
        turnCount: nextTurn,
        memoryDigest,
        scenarioTitle: session.scenarioTitle,
      });
      narration = eng.narration;
      choices = eng.choices;
      dice = eng.dice;
      loot = eng.loot;
      effects = eng.effects;
      flags = eng.flags;
      modelUsed = "offline-engine (fallback)";
      completionTokens = estimateTokens(narration);
    }
  } else {
    // Чистый офлайн-движок
    const eng = runOfflineEngine({
      playerAction,
      character: { name: character.name, archetype: character.archetype, stats: character.stats, hp: character.hp, maxHp: character.maxHp },
      world: { worldName: world.worldName, currentLocation: world.currentLocation, mainQuest: world.mainQuest, danger: world.danger, chapter: world.chapter },
      turnCount: nextTurn,
      memoryDigest,
      scenarioTitle: session.scenarioTitle,
    });
    narration = eng.narration;
    choices = eng.choices;
    dice = eng.dice;
    loot = eng.loot;
    effects = eng.effects;
    flags = eng.flags;
    completionTokens = estimateTokens(narration);
    promptTokens = estimateTokens(playerAction + memoryDigest);
  }

  // ── Применяем эффекты состояния ──
  const newHp = Math.max(0, Math.min(character.maxHp, character.hp + effects.hp));
  const newXp = character.xp + effects.xp;
  const newLevel = 1 + Math.floor(newXp / 120);
  const leveled = newLevel > character.level;
  const newGold = Math.max(0, character.gold + effects.gold);
  const newDanger = Math.max(0, Math.min(100, world.danger + effects.dangerDelta));
  const dead = newHp <= 0;

  // Если персонаж погиб — немедленно восстанавливаем 1 HP (single update, нет промежуточного состояния hp=0)
  const finalHp = dead ? 1 : newHp;
  const finalGold = dead ? Math.max(0, newGold - 10) : newGold;

  await db
    .update(gameSessions)
    .set({
      character: { ...character, hp: finalHp, xp: newXp, gold: finalGold, level: newLevel, maxHp: leveled ? character.maxHp + 5 : character.maxHp },
      worldState: { ...world, danger: newDanger, flags: { ...(world.flags ?? {}), ...flags }, chapter: nextTurn % 15 === 0 ? world.chapter + 1 : world.chapter },
      // turnCount = последний вставленный turnNumber, чтобы следующий nextTurn = turnCount + 1
      // Нарратор = nextTurn + 1, Кости (если есть) = nextTurn + 2
      turnCount: dice !== null ? nextTurn + 2 : nextTurn + 1,
      // Обновляем оценку размера контекста для мониторинга (видно в UI)
      contextTokensEstimate: promptTokens,
      updatedAt: new Date(),
    })
    .where(eq(gameSessions.id, id));

  // Ход нарратора (turnNumber = nextTurn + 1)
  await db.insert(gameTurns).values({
    sessionId: id,
    turnNumber: nextTurn + 1,
    role: "narrator",
    content: dead
      ? `${narration}\n\n💀 **${character.name} пал(а).** Но хроника не закрывается: эхо легенды возвращает героя с 1 HP — ценой утраченного золота (−10). Продолжай.`
      : narration,
    choices,
    dice: dice as unknown as null,
    modelUsed,
    taskType,
    promptTokens,
    completionTokens,
  });

  // Ход броска костей (отдельный turnNumber = nextTurn + 2, чтобы не коллидировать с нарратором)
  if (dice) {
    await db.insert(gameTurns).values({
      sessionId: id,
      turnNumber: nextTurn + 2,
      role: "dice",
      content: `🎲 ${dice.label}`,
      choices: [],
      dice: dice as unknown as null,
      modelUsed: "d20",
      taskType: "fast",
      promptTokens: 0,
      completionTokens: 10,
    });
  }

  // Добавление лута в инвентарь
  for (const l of loot.slice(0, 3)) {
    await db.insert(inventoryItems).values({
      sessionId: id,
      name: String(l.name).slice(0, 80),
      kind: String((l as { kind?: string }).kind ?? "misc").slice(0, 20),
      description: String(l.description ?? "").slice(0, 500),
      quantity: 1,
      icon: (l as { icon?: string }).icon ?? "🎒",
    });
  }

  // Извлечение кандидатов в память
  const cands = [...extractMemoryCandidates(playerAction, nextTurn), ...extractMemoryCandidates(narration, nextTurn + 1)];
  for (const c of cands.slice(0, 4)) {
    await db.insert(memoryNodes).values({
      sessionId: id,
      layer: c.layer,
      category: c.category,
      title: c.title.slice(0, 120),
      content: c.content.slice(0, 800),
      importance: c.importance,
      salience: 60,
      tokensEstimate: estimateTokens(c.content),
      turnFrom: c.turnFrom ?? nextTurn,
      turnTo: c.turnTo ?? nextTurn + 1,
    });
  }

  // Автоматическая хроника при смене главы
  if ((nextTurn + 1) % 15 === 0) {
    await db.insert(memoryNodes).values({
      sessionId: id,
      layer: "chronicle",
      category: "event",
      title: `Глава ${world.chapter}: рубеж на ходе ${nextTurn + 1}`,
      content: narration.slice(0, 500),
      importance: 90,
      salience: 85,
      tokensEstimate: estimateTokens(narration.slice(0, 500)),
      turnFrom: nextTurn - 14,
      turnTo: nextTurn + 1,
    });
  }

  // Проверяем необходимость компакции: если условие выполняется, клиент получает флаг needsCompaction: true
  // и на следующем взаимодействии вызывает POST /compact (избегаем inline-задержку текущего хода).
  // lastCompactTurn выводится из последней chronicle-ноды (создаётся при компакции и авто-хронике).
  const lastChronicleNode = mems.filter((m) => m.layer === "chronicle").sort((a, b) => (b.turnTo ?? 0) - (a.turnTo ?? 0))[0];
  const lastCompactTurn = lastChronicleNode?.turnTo ?? 0;
  const workingTokensEstimate = estimateTokens(recentTurns);
  const needsCompaction = shouldCompact(nextTurn, lastCompactTurn, workingTokensEstimate);

  return NextResponse.json({ ok: true, narration, choices, dice, effects, loot, modelUsed, dead, taskType, needsCompaction });
}

