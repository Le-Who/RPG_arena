import { NextResponse } from "next/server";
import { db } from "@/db";
import { gameSessions, gameTurns, memoryNodes, inventoryItems, worldLocations } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { SCENARIOS } from "@/lib/scenarios";
import { estimateTokens } from "@/lib/gemini";
import { openingChoices } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const sessions = await db.select().from(gameSessions).orderBy(desc(gameSessions.updatedAt)).limit(30);
  return NextResponse.json({ sessions });
}

type CreateBody = {
  mode: "preset" | "custom";
  scenarioId?: string;
  characterIndex?: number;
  customScenario?: { title: string; worldName: string; pitch: string; mainQuest: string; tone: string };
  customCharacter?: { name: string; archetype: string; backstory: string; stats?: Record<string, number> };
};

function baseStats(over?: Record<string, number>) {
  return { СИЛ: 12, ЛОВ: 13, ВЫН: 12, ИНТ: 12, МУД: 13, ХАР: 12, ...(over ?? {}) };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as CreateBody;
  const now = new Date();

  let title = "Своя история";
  let scenarioTitle = "Своя история";
  let scenarioPrompt = "";
  let worldName = "Неведомые земли";
  let tone = "приключенческий";
  let mainQuest = "Выжить и найти свой путь";
  let startLocation = "Перекрёсток";
  let factions: string[] = [];
  let danger = 30;
  let intro = "";
  let locs: { name: string; description: string; x: number; y: number; danger: number; icon: string }[] = [];
  let char: { name: string; archetype: string; backstory: string; stats: Record<string, number>; skills: string[]; traits: string[] } = { name: "Странник", archetype: "Авантюрист", backstory: "Прошлое туманно.", stats: baseStats(), skills: ["Выживание", "Восприятие"], traits: ["Упрямство"] };

  if (body.mode === "preset") {
    const sc = SCENARIOS.find((s) => s.id === body.scenarioId) ?? SCENARIOS[0];
    const ch = sc.characters[body.characterIndex ?? 0] ?? sc.characters[0];
    title = sc.title;
    scenarioTitle = sc.title;
    scenarioPrompt = sc.pitch;
    worldName = sc.worldName;
    tone = sc.tone;
    mainQuest = sc.mainQuest;
    startLocation = sc.startLocation;
    factions = sc.factions;
    danger = sc.danger;
    intro = sc.intro;
    locs = sc.locations;
    char = {
      name: ch.name,
      archetype: ch.archetype,
      backstory: ch.backstory,
      stats: ch.stats,
      skills: ch.skills,
      traits: ch.traits,
    };
  } else {
    const cs = body.customScenario;
    const cc = body.customCharacter;
    title = cs?.title?.slice(0, 80) || "Своя история";
    scenarioTitle = title;
    scenarioPrompt = cs?.pitch?.slice(0, 2000) || "Свободная история, заданная игроком.";
    worldName = cs?.worldName?.slice(0, 80) || "Авторский мир";
    tone = cs?.tone?.slice(0, 80) || "приключенческий";
    mainQuest = cs?.mainQuest?.slice(0, 500) || "Выжить и найти свой путь";
    intro =
      scenarioPrompt.length > 20
        ? `История «${title}» начинается. ${scenarioPrompt.slice(0, 500)} Ты стоишь на пороге событий — ${mainQuest}. Ветер ${worldName} пахнет возможностями и опасностью.`
        : "Чистый лист. Мир ждёт первого твоего шага — опиши его своими словами, и история подхватит.";
    locs = [
      { name: startLocation, description: "Точка начала пути", x: 5, y: 5, danger: 15, icon: "📍" },
      { name: "Туманная тропа", description: "Дорога, которой нет на картах", x: 7, y: 4, danger: 30, icon: "🌫️" },
      { name: "Древние руины", description: "Эхо забытой эпохи", x: 3, y: 3, danger: 45, icon: "🏚️" },
    ];
    if (cc?.name) {
      char = {
        name: cc.name.slice(0, 40),
        archetype: cc.archetype?.slice(0, 40) || "Авантюрист",
        backstory: cc.backstory?.slice(0, 800) || "Прошлое туманно.",
        stats: baseStats(cc.stats),
        skills: ["Выживание", "Восприятие", "Убеждение"],
        traits: ["Авторский герой"],
      };
    }
  }

  const character = {
    name: char.name,
    archetype: char.archetype,
    level: 1,
    xp: 0,
    hp: 40,
    maxHp: 40,
    mana: 20,
    maxMana: 20,
    gold: 15,
    stats: char.stats,
    skills: char.skills,
    traits: char.traits,
    backstory: char.backstory,
    appearance: "Определяется по ходу истории",
  };

  const worldState = {
    worldName,
    tone,
    era: "Сейчас",
    mainQuest,
    currentLocation: startLocation,
    factions,
    flags: {},
    danger,
    chapter: 1,
  };

  const inserted = await db
    .insert(gameSessions)
    .values({
      title,
      scenarioId: body.mode === "preset" ? (body.scenarioId ?? "custom") : "custom",
      scenarioTitle,
      scenarioPrompt: `${scenarioPrompt}\nТон: ${tone}`,
      character,
      worldState,
      turnCount: 1,
      contextTokensEstimate: estimateTokens(intro + scenarioPrompt),
    })
    .returning();
  const session = inserted[0];

  // стартовый ход нарратора
  const choices = openingChoices(mainQuest);
  await db.insert(gameTurns).values({
    sessionId: session.id,
    turnNumber: 1,
    role: "narrator",
    content: intro,
    choices,
    taskType: "narration",
    modelUsed: "offline-engine",
    promptTokens: 0,
    completionTokens: estimateTokens(intro),
  });

  // Fix #5: контент нод вычисляется заранее, tokensEstimate — через estimateTokens().
  // Хардкод 80/90/50 расходился с реальностью при длинных backstory/квестах.
  const chronicleContent = `Мир: ${worldName}. Квест: ${mainQuest}. Герой ${character.name} (${character.archetype}) начинает в «${startLocation}». Тон: ${tone}.`;
  const semanticContent = `${character.archetype}. ${character.backstory} Статы: ${Object.entries(character.stats).map(([k, v]) => `${k} ${v}`).join(", ")}. Навыки: ${character.skills.join(", ")}.`;
  const proceduralContent = "Проверки d20+мод vs DC. Крит 20 — триумф, 1 — провал. HP 40, урон снижает, зелья лечат. Выбор игрока или своё действие.";

  // базовая память: chronicle + semantic + procedural
  await db.insert(memoryNodes).values([
    {
      sessionId: session.id,
      layer: "chronicle",
      category: "quest",
      title: "Глава 1: Начало",
      content: chronicleContent,
      importance: 95,
      salience: 90,
      tokensEstimate: estimateTokens(chronicleContent),
      turnFrom: 0,
      turnTo: 1,
    },
    {
      sessionId: session.id,
      layer: "semantic",
      category: "character",
      title: `Герой: ${character.name}`,
      content: semanticContent,
      importance: 90,
      salience: 85,
      tokensEstimate: estimateTokens(semanticContent),
      turnFrom: 0,
      turnTo: 1,
    },
    {
      sessionId: session.id,
      layer: "procedural",
      category: "rule",
      title: "Правила d20",
      content: proceduralContent,
      importance: 60,
      salience: 40,
      tokensEstimate: estimateTokens(proceduralContent),
      turnFrom: 0,
      turnTo: 1,
    },
  ]);

  // стартовый инвентарь: только для preset-режима
  // custom-режим намеренно стартует с пустым инвентарём —
  // игрок может взаимодействовать с любым объектом мира, и лут нарастает
  // исключительно через resolution engine (свободные действия).
  if (body.mode === "preset") {
    await db.insert(inventoryItems).values([
      { sessionId: session.id, name: "Дорожный паёк", kind: "consumable", description: "+10 HP вне боя", quantity: 2, icon: "🍞", power: 10 },
      { sessionId: session.id, name: "Простой клинок", kind: "weapon", description: "Верный спутник", quantity: 1, equipped: true, icon: "🗡️", power: 3 },
      { sessionId: session.id, name: "Письмо-загадка", kind: "quest", description: "Крючок главного квеста", quantity: 1, icon: "✉️", power: 0 },
    ]);
  }

  // карта
  let idx = 0;
  for (const l of locs) {
    await db.insert(worldLocations).values({
      sessionId: session.id,
      name: l.name,
      description: l.description,
      x: l.x,
      y: l.y,
      danger: l.danger,
      icon: l.icon,
      discovered: idx < 2,
      current: idx === 0,
      connectedTo: [],
    });
    idx++;
  }

  await db.update(gameSessions).set({ updatedAt: now }).where(eq(gameSessions.id, session.id));

  return NextResponse.json({ session });
}
