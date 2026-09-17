import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiSettings, gameSessions, gameTurns, inventoryItems, memoryNodes, tokenLogs } from "@/db/schema";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
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
import { assembleMemoryDigest, extractMemoryCandidates, shouldCompact, LAYER_INFO } from "@/lib/memory";
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
  const isCustom: boolean = Boolean(body.custom);

  const sRows = await db.select().from(gameSessions).where(eq(gameSessions.id, id));
  if (!sRows[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  const session = sRows[0];
  const character = session.character as typeof session.character;
  const world = session.worldState as typeof session.worldState;

  // Загружаем AI-конфиг ДО выборки ходов, чтобы правильно определить tier и размер окна.
  const aiConf = await getAI();
  const canUseLive = aiConf.useLiveAI && aiConf.keys.length > 0;

  // Tier модели: flash для свободных действий (resolution), lite для стандартного нарратива.
  const routingModels = routeModelsFor(isCustom ? "resolution" : "narration", aiConf.routingConfig);
  const primaryModel = routingModels[0] ?? "gemini-3.5-flash-lite";
  const modelTier: ModelTier = isLite(primaryModel) ? "lite" : "flash";

  // Fix #2: desc+limit+reverse вместо limit(500)+slice(-N).
  // Гарантирует корректное окно даже при >500 ходов в кампании.
  const recentCount = modelTier === "flash" ? 16 : 10;
  const recentCharLimit = modelTier === "flash" ? 1500 : 1000;
  const recentTurnsRaw = await db
    .select()
    .from(gameTurns)
    .where(eq(gameTurns.sessionId, id))
    .orderBy(desc(gameTurns.turnNumber))
    .limit(recentCount);
  const recentTurns = recentTurnsRaw
    .reverse()
    .map((t) => `[${t.role} #${t.turnNumber}]: ${t.content.slice(0, recentCharLimit)}`)
    .join("\n");

  // Весовое ранжирование: importance×0.7 + salience×0.3
  // Гарантирует, что свежие NPC-ноды (высокий salience, средний importance)
  // не вытесняются старыми событиями (высокий importance, упавший salience)
  // до того, как запустится assembleMemoryDigest с decay.
  const mems = await db
    .select()
    .from(memoryNodes)
    .where(eq(memoryNodes.sessionId, id))
    .orderBy(desc(sql`${memoryNodes.importance} * 0.7 + ${memoryNodes.salience} * 0.3`))
    .limit(60);

  const memoryDigest = assembleMemoryDigest(
    mems.map((m) => ({
      layer: m.layer,
      title: m.title,
      content: m.content,
      importance: m.importance,
      salience: m.salience,
      turnTo: m.turnTo ?? undefined,
    })),
    modelTier,
    session.turnCount ?? 0,
  );

  const nextTurn = (session.turnCount ?? 0) + 1;

  // Сохраняем ход игрока
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
  const worldLine = `Мир ${world.worldName}, тон: ${world.tone ?? "приключенческий"}, квест: ${world.mainQuest}, глава ${world.chapter}, накал ${world.danger}`;

  if (canUseLive) {
    try {
      const models = routeModelsFor(taskType, aiConf.routingConfig);
      // Fix #9: расширяем окно scenarioPrompt с 600 до 1400 символов.
      const system = isCustom
        ? buildResolutionSystemPrompt({ tone: world.tone, worldName: world.worldName })
        : buildNarrationSystemPrompt({
            character: charLine,
            worldDigest: `${worldLine}. Предыстория: ${session.scenarioPrompt.slice(0, 1400)}`,
            memoryDigest,
            recentTurns,
            location: world.currentLocation,
            tone: world.tone ?? "приключенческий",
          });
      const user = isCustom
        // Fix #2: добавляем memoryDigest в user-промпт для свободных действий.
        // Без этого модель видела recentTurns, но не структурированную память об NPC/квестах/предметах
        // и могла противоречить канону (использовать неверные имена, забывать артефакты и т.п.).
        ? `ПАМЯТЬ КАНА (соблюдай строго):\n${memoryDigest}\n\nПоследние события:\n${recentTurns}\n\nДействие игрока (free-form): ${playerAction}\nПерсонаж: ${charLine}\nЛокация: ${world.currentLocation}`
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

  // Если персонаж погиб — восстанавливаем 1 HP сразу (нет промежуточного hp=0)
  const finalHp = dead ? 1 : newHp;
  const finalGold = dead ? Math.max(0, newGold - 10) : newGold;

  // Fix #11: единое условие для инкремента главы И создания chronicle-ноды.
  // Ранее расходились: chapter += при nextTurn%15, chronicle при (nextTurn+1)%15.
  const isChapterBoundary = nextTurn % 15 === 0;

  await db
    .update(gameSessions)
    .set({
      character: { ...character, hp: finalHp, xp: newXp, gold: finalGold, level: newLevel, maxHp: leveled ? character.maxHp + 5 : character.maxHp },
      worldState: {
        ...world,
        danger: newDanger,
        flags: { ...(world.flags ?? {}), ...flags },
        chapter: isChapterBoundary ? world.chapter + 1 : world.chapter,
      },
      turnCount: dice !== null ? nextTurn + 2 : nextTurn + 1,
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

  // Ход броска костей (отдельный turnNumber = nextTurn + 2, не коллидирует с нарратором)
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

  // Fix #7: дедупликация кандидатов памяти по layer+category.
  // Ранее playerAction и narration могли породить два дублирующих узла для одного события.
  // При дублировании побеждает узел с большим content (нарратор информативнее).
  const rawCands = [
    ...extractMemoryCandidates(playerAction, nextTurn),
    ...extractMemoryCandidates(narration, nextTurn + 1),
  ];
  const dedupMap = new Map<string, typeof rawCands[0]>();
  for (const c of rawCands) {
    const key = `${c.layer}:${c.category}`;
    const existing = dedupMap.get(key);
    if (!existing || c.content.length > existing.content.length) {
      dedupMap.set(key, c);
    }
  }
  for (const c of [...dedupMap.values()].slice(0, 4)) {
    await db.insert(memoryNodes).values({
      sessionId: id,
      layer: c.layer,
      category: c.category,
      title: c.title.slice(0, 120),
      content: c.content.slice(0, 800),
      importance: c.importance,
      // Fix #3: salience пропорционален importance, а не хардкод 60.
      // Нижний порог 45 (а не 50 как в компакции) — эвристические ноды менее надёжны.
      salience: Math.min(95, Math.max(45, c.importance)),
      tokensEstimate: estimateTokens(c.content),
      turnFrom: c.turnFrom ?? nextTurn,
      turnTo: c.turnTo ?? nextTurn + 1,
    });
  }

  // Fix #11: chronicle создаётся при том же условии, что и смена главы
  if (isChapterBoundary) {
    await db.insert(memoryNodes).values({
      sessionId: id,
      layer: "chronicle",
      category: "event",
      // Fix #9: world.chapter здесь — значение ДО инкремента (инкремент на строке ~331).
      // Нода описывает итоги ЗАВЕРШЁННОЙ главы N, а не начало главы N+1.
      title: `Глава ${world.chapter} завершена (ход ${nextTurn})`,
      content: `[Завершение главы ${world.chapter}] ${narration.slice(0, 460)}`,
      importance: 90,
      salience: 85,
      tokensEstimate: estimateTokens(`[Завершение главы ${world.chapter}] ${narration.slice(0, 460)}`),
      turnFrom: nextTurn - 14,
      turnTo: nextTurn,
    });
  }

  // Fix #7: при повышении уровня вставляем обновлённую procedural-ноду.
  // Стартовая нода (importance: 60) остаётся в БД, но новая (importance: 75)
  // вытесняет её из топ-60 при ранжировании в assembleMemoryDigest.
  if (leveled) {
    const newMaxHp = character.maxHp + 5; // соответствует логике строки ~326
    const proceduralContent = `Уровень ${newLevel}. Статы: ${Object.entries(character.stats).map(([k, v]) => `${k}:${v}`).join(" ")}. Навыки: ${character.skills.join(", ")}. Черты: ${(character.traits ?? []).join(", ")}. HP: ${newMaxHp}/${newMaxHp}.`;
    await db.insert(memoryNodes).values({
      sessionId: id,
      layer: "procedural",
      category: "rule",
      title: `Уровень ${newLevel}: способности персонажа`,
      content: proceduralContent,
      importance: 75,
      salience: 70,
      tokensEstimate: estimateTokens(proceduralContent),
      turnFrom: nextTurn,
      turnTo: nextTurn,
    });
  }

  // Fix #4: lastCompactTurn из сессии, а не из chronicle-нод внутри limit(60).
  const lastCompactTurn = (session.lastCompactTurn as number | null) ?? 0;
  const workingTokensEstimate = estimateTokens(recentTurns);
  const workingBudget = modelTier === "flash" ? 8000 : LAYER_INFO.working.budget;

  // Fix #6: считаем только player-ходы (role = "player") после lastCompactTurn.
  // Dice-записи (role = "dice") увеличивают turnNumber на +1 за каждый бросок,
  // что раньше приближало порог компакции вдвое быстрее реальных действий игрока.
  const playerCountResult = await db
    .select({ c: count() })
    .from(gameTurns)
    .where(
      and(
        eq(gameTurns.sessionId, id),
        eq(gameTurns.role, "player"),
        gt(gameTurns.turnNumber, lastCompactTurn),
      ),
    );
  const playerTurnsSinceCompact = playerCountResult[0]?.c ?? 0;
  // playerTurnsSinceCompact — реальные действия игрока; 0 как второй аргумент потому,
  // что SQL-фильтр gt(turnNumber, lastCompactTurn) уже выполнил отсечение.
  const needsCompaction = shouldCompact(playerTurnsSinceCompact, 0, workingTokensEstimate, workingBudget);

  return NextResponse.json({ ok: true, narration, choices, dice, effects, loot, modelUsed, dead, taskType, needsCompaction });
}
