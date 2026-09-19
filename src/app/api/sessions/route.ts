import { readJsonObject, httpError } from "@/lib/http";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { db } from "@/db";
import { gameSessions, gameTurns, inventoryItems, worldLocations, quests, type CampaignMode, type RulesProfile } from "@/db/schema";
import { desc, eq, getTableColumns } from "drizzle-orm";
import { SCENARIOS } from "@/lib/scenarios";
import { estimateTokens } from "@/lib/gemini";
import { openingChoices } from "@/lib/engine";
import { isRulesProfile, profileFor } from "@/lib/profiles";
import { upsertMemoryNode } from "@/lib/memory";
import { slugify, iconForKind } from "@/lib/resolution";
import { getAIConfig } from "@/lib/ai-settings";
import { enqueueEmbeddings, indexPendingEmbeddings } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

export async function GET() {
  const { scenarioPrompt: _omit, ...listColumns } = getTableColumns(gameSessions);
  const sessions = await db.select(listColumns).from(gameSessions).orderBy(desc(gameSessions.updatedAt)).limit(100);
  return NextResponse.json({ sessions });
}

type CreateBody = {
  mode?: "preset" | "free" | "custom";
  scenarioId?: string;
  characterIndex?: number;
  rulesProfile?: RulesProfile;
  customScenario?: { title?: string; worldName?: string; pitch?: string; mainQuest?: string; tone?: string; era?: string; startLocation?: string; factions?: string[] };
  customCharacter?: { name?: string; archetype?: string; backstory?: string; stats?: Record<string, number>; skills?: string[]; traits?: string[]; startItems?: string[] };
};

const STAT_KEYS = ["СИЛ", "ЛОВ", "ВЫН", "ИНТ", "МУД", "ХАР"];
function normalizeStats(over?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { СИЛ: 12, ЛОВ: 13, ВЫН: 12, ИНТ: 12, МУД: 13, ХАР: 12 };
  for (const k of STAT_KEYS) {
    const v = Number(over?.[k]);
    if (Number.isFinite(v)) out[k] = Math.max(3, Math.min(20, Math.round(v)));
  }
  return out;
}
const clean = (v: unknown, max: number, dflt = "") => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : dflt);
const cleanList = (v: unknown, max: number, itemMax = 40) => (Array.isArray(v) ? v.map((x) => clean(x, itemMax)).filter(Boolean).slice(0, max) : []);

export async function POST(req: Request) {
  try {
  const raw = await readJsonObject(req, 32768);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  const body = raw as CreateBody;
  if (body.mode !== "preset" && body.mode !== "free" && body.mode !== "custom") return NextResponse.json({ error: "Укажите режим кампании" }, { status: 400 });
  if (body.mode === "preset" && !SCENARIOS.some((s) => s.id === body.scenarioId)) return NextResponse.json({ error: "Сценарий не найден" }, { status: 400 });
  if (body.mode !== "preset" && (typeof body.customScenario?.title !== "string" || !body.customScenario.title.trim())) return NextResponse.json({ error: "Назовите вашу историю" }, { status: 400 });
  const mode: CampaignMode = body.mode === "preset" ? "preset" : "free";
  const now = new Date();

  let title: string;
  let scenarioTitle: string;
  let scenarioId: string;
  let scenarioPrompt: string;
  let worldName: string;
  let tone: string;
  let era: string;
  let mainQuest: string;
  let startLocation: string;
  let factions: string[] = [];
  let danger: number;
  let intro: string;
  let rulesProfile: RulesProfile;
  let locs: { name: string; description: string; x: number; y: number; danger: number; icon: string }[] = [];
  let startInventory: { name: string; kind: string; description: string; quantity: number; equipped?: boolean; icon: string; power: number }[] = [];
  let char: { name: string; archetype: string; backstory: string; stats: Record<string, number>; skills: string[]; traits: string[] };

  if (mode === "preset") {
    const sc = SCENARIOS.find((s) => s.id === body.scenarioId) ?? SCENARIOS[0];
    const ch = sc.characters[body.characterIndex ?? 0] ?? sc.characters[0];
    title = sc.title;
    scenarioTitle = sc.title;
    scenarioId = sc.id;
    scenarioPrompt = sc.pitch;
    worldName = sc.worldName;
    tone = sc.tone;
    era = sc.genre;
    mainQuest = sc.mainQuest;
    startLocation = sc.startLocation;
    factions = sc.factions;
    danger = sc.danger;
    intro = sc.intro;
    rulesProfile = sc.rulesProfile; // ARCH-1b: пресет объявляет профиль как часть спецификации
    locs = sc.locations;
    startInventory = sc.startInventory;
    char = { name: ch.name, archetype: ch.archetype, backstory: ch.backstory, stats: ch.stats, skills: ch.skills, traits: ch.traits };
  } else {
    const cs = body.customScenario ?? {};
    const cc = body.customCharacter ?? {};
    rulesProfile = isRulesProfile(body.rulesProfile) ? body.rulesProfile : "narrative";
    title = clean(cs.title, 80, "Своя история");
    scenarioTitle = title;
    scenarioId = "custom";
    scenarioPrompt = clean(cs.pitch, 2000, "Свободная история, заданная игроком.");
    worldName = clean(cs.worldName, 80, "Авторский мир");
    tone = clean(cs.tone, 80, "нейтральный, реалистичный");
    era = clean(cs.era, 80, "не указана");
    mainQuest = clean(cs.mainQuest, 500, "Разобраться в происходящем и определить свой путь");
    startLocation = clean(cs.startLocation, 80, "Начальная точка");
    factions = cleanList(cs.factions, 6, 60);
    danger = 20;
    // ARCH-1e: никаких «туманных троп» и «древних руин» — карту строит сама история
    locs = [{ name: startLocation, description: "Здесь начинается история", x: 6, y: 5, danger: 15, icon: "📍" }];
    intro =
      scenarioPrompt.length > 20
        ? `${scenarioPrompt.slice(0, 600)}\n\nИстория «${title}» начинается здесь: ${startLocation}. Впереди — ${mainQuest.charAt(0).toLowerCase() + mainQuest.slice(1)}. Опиши свой первый шаг или выбери один из вариантов.`
        : `Чистый лист. Мир «${worldName}» ждёт первого шага — опиши его своими словами, и история подхватит.`;
    const spec = profileFor(rulesProfile);
    char = {
      name: clean(cc.name, 40, "Безымянный"),
      archetype: clean(cc.archetype, 40, "Обычный человек"),
      backstory: clean(cc.backstory, 800, "Прошлое пока не раскрыто."),
      stats: spec.resources.stats ? normalizeStats(cc.stats) : {},
      skills: cleanList(cc.skills, 6),
      traits: cleanList(cc.traits, 6),
    };
    startInventory = cleanList(cc.startItems, 6, 60).map((name) => ({ name, kind: "misc", description: "Взято с собой", quantity: 1, icon: iconForKind("misc"), power: 0 }));
  }

  const spec = profileFor(rulesProfile);
  const character = {
    name: char.name,
    archetype: char.archetype,
    level: 1,
    xp: 0,
    hp: spec.resources.hp ? 40 : 0,
    maxHp: spec.resources.hp ? 40 : 0,
    gold: spec.resources.gold ? 15 : 0,
    stats: spec.resources.stats ? char.stats : {},
    skills: char.skills,
    traits: char.traits,
    backstory: char.backstory,
    appearance: "Определяется по ходу истории",
    conditions: [] as string[],
  };
  const worldState = { worldName, tone, era, mainQuest, currentLocation: startLocation, factions, flags: {}, danger, chapter: 1 };

  const { session, seedIds } = await db.transaction(async (tx) => {
  const inserted = await tx
    .insert(gameSessions)
    .values({
      title,
      scenarioId,
      scenarioTitle,
      scenarioPrompt: `${scenarioPrompt}\nТон: ${tone}`,
      campaignMode: mode,
      rulesProfile,
      character,
      worldState,
      turnCount: 1,
      contextTokensEstimate: estimateTokens(intro + scenarioPrompt),
    })
    .returning();
  const session = inserted[0];

  await tx.insert(gameTurns).values({
    sessionId: session.id,
    turnNumber: 1,
    role: "narrator",
    content: intro,
    choices: mode === "preset" ? openingChoices() : [],
    taskType: "narration",
    modelUsed: mode === "preset" ? "preset-intro" : "author-intro",
    promptTokens: 0,
    completionTokens: estimateTokens(intro),
  });

  // Квест-хранилище (RES-1a): главный квест — строка в quests, worldState.mainQuest остаётся зеркалом для промптов
  await tx.insert(quests).values({ sessionId: session.id, key: "main", title: mainQuest, description: "Главная цель истории", status: "active", progress: 0, isMain: true, updatedTurn: 1 });

  // Канонические стартовые ноды (source = seed)
  const seedIds: string[] = [];
  const chronicleContent = `Мир: ${worldName} (${era}). Главная цель: ${mainQuest}. Герой ${character.name} (${character.archetype}) начинает в «${startLocation}». Тон: ${tone}.`;
  const semanticContent = `${character.archetype}. ${character.backstory}${spec.resources.stats ? ` Статы: ${Object.entries(character.stats).map(([k, v]) => `${k} ${v}`).join(", ")}.` : ""}${character.skills.length ? ` Навыки: ${character.skills.join(", ")}.` : ""}${character.traits.length ? ` Черты: ${character.traits.join(", ")}.` : ""}`;
  const proceduralContent = spec.promptCanon;
  for (const n of [
    { layer: "chronicle" as const, category: "quest", title: "Глава 1: Начало", content: chronicleContent, importance: 95, entityKey: "chapter:0" },
    { layer: "semantic" as const, category: "character", title: `Герой: ${character.name}`, content: semanticContent, importance: 90, entityKey: "character:core" },
    { layer: "procedural" as const, category: "rule", title: `Правила: профиль ${spec.label}`, content: proceduralContent, importance: 60, entityKey: "rules:profile" },
    ...(factions.length ? [{ layer: "semantic" as const, category: "world", title: "Фракции", content: `Силы мира: ${factions.join(", ")}.`, importance: 70, entityKey: "world:factions" }] : []),
  ]) {
    const r = await upsertMemoryNode({ sessionId: session.id, ...n, source: "seed", sourceTurn: 1, mode: "upsert", turnFrom: 0, turnTo: 1 }, tx);
    seedIds.push(r.id);
  }

  if (startInventory.length) {
    await tx.insert(inventoryItems).values(startInventory.map((i) => ({ sessionId: session.id, name: i.name, kind: i.kind, description: i.description, quantity: i.quantity, equipped: Boolean(i.equipped), icon: i.icon, power: i.power })));
  }

  let idx = 0;
  for (const l of locs) {
    await tx.insert(worldLocations).values({ sessionId: session.id, name: idx === 0 ? startLocation : l.name, description: l.description, x: l.x, y: l.y, danger: l.danger, icon: l.icon, discovered: idx < 2, current: idx === 0, connectedTo: [] });
    idx++;
  }
  await tx.update(gameSessions).set({ updatedAt: now }).where(eq(gameSessions.id, session.id));

  return { session, seedIds };
  });

  // Индексация стартовых нод — в фоне
  after(async () => {
    try {
      const cfg = await getAIConfig();
      if (!cfg.keys.length || !cfg.embeddingsEnabled) return;
      await enqueueEmbeddings(session.id, seedIds, cfg.embeddingModel, cfg.embeddingDims);
      await indexPendingEmbeddings({ sessionId: session.id, keys: cfg.keys, model: cfg.embeddingModel, dims: cfg.embeddingDims });
    } catch (e) {
      console.warn("[seed-embed]", e instanceof Error ? e.message : e);
    }
  });

  return NextResponse.json({ session, slug: slugify(title) });
  } catch (error) { return httpError(error); }
}
