import { test } from "node:test";
import assert from "node:assert/strict";
import { applyResolution, parseResolution, slugify, type ApplyInput } from "../src/lib/resolution";
import { rollD20, roll2d6 } from "../src/lib/dice";
import { filterByDailyLimits } from "../src/lib/gemini";
import { normalizeExtractedFacts } from "../src/lib/memory";
import { cosine } from "../src/lib/embeddings";
import { assessRisk } from "../src/lib/profiles";

function baseInput(over: Partial<ApplyInput> = {}): ApplyInput {
  return {
    rulesProfile: "d20",
    campaignMode: "free",
    character: { name: "Ада", archetype: "Следователь", level: 1, xp: 0, hp: 30, maxHp: 40, mana: 0, maxMana: 0, gold: 15, stats: { СИЛ: 10 }, skills: [], traits: [], backstory: "", appearance: "", conditions: [] },
    world: { worldName: "Город", tone: "нуар", era: "1950", mainQuest: "Найти брата", currentLocation: "Бар «Ржавый якорь»", factions: [], flags: {}, danger: 30, chapter: 1 },
    inventory: [{ id: "aaaaaaaa-0000-0000-0000-000000000000", name: "Аптечка", kind: "consumable", quantity: 1, equipped: false, description: "", icon: "🧪", power: 10 }],
    quests: [{ id: "q1", key: "main", title: "Найти брата", status: "active", progress: 10, isMain: true, description: "" }],
    npcs: [],
    sceneObjects: [],
    locations: [{ id: "l1", name: "Бар «Ржавый якорь»", x: 5, y: 5, current: true, discovered: true, danger: 20 }],
    payload: parseResolution("{}").payload,
    dice: null,
    turnNumber: 5,
    rng: () => 0.5,
    ...over,
  };
}

test("parseResolution: текстовый фолбэк без JSON", () => {
  const r = parseResolution("Ты входишь в бар.\nВАРИАНТЫ: 1) Сесть | 2) Уйти | 3) Спросить");
  assert.equal(r.parsedJson, false);
  assert.equal(r.payload.narration, "Ты входишь в бар.");
  assert.deepEqual(r.payload.choices, ["Сесть", "Уйти", "Спросить"]);
});

test("parseResolution: нормализует и клампит JSON", () => {
  const r = parseResolution(JSON.stringify({ narration: "x", outcome: "weird", choices: ["a"], effects: { hp: -999, xp: "7" }, stateChanges: { flags: [{ key: "k", value: "v" }], inventory: [{ op: "consume", ref: "#aaaaaa", name: "Аптечка", quantity: 1 }] } }));
  assert.equal(r.payload.outcome, "neutral");
  assert.equal(r.payload.effects.hp, -100);
  assert.equal(r.payload.effects.xp, 7);
  assert.equal(r.payload.stateChanges.inventory[0].ref, "aaaaaa");
  assert.equal(r.payload.stateChanges.flags.k, "v");
});

test("reducer: расходник нельзя использовать дважды (INV-1h)", () => {
  const payload = parseResolution(JSON.stringify({ narration: "x", outcome: "success", choices: ["a", "b", "c"], effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: { inventory: [{ op: "consume", ref: "#aaaaaa", name: "Аптечка", quantity: 1 }, { op: "consume", ref: "#aaaaaa", name: "Аптечка", quantity: 1 }] } })).payload;
  const r = applyResolution(baseInput({ payload }));
  assert.equal(r.applied.inventory.filter((i) => i.ok).length, 1);
  assert.equal(r.applied.inventory.filter((i) => !i.ok).length, 1);
  assert.equal(r.ops.filter((o) => o.t === "inv.delete").length, 1);
  assert.equal(r.character.hp, 40); // лечение по power=10 с 30 до 40
});

test("reducer: предмет не появляется из текста при провале; лимиты профиля narrative обнуляют ресурсы", () => {
  const payload = parseResolution(JSON.stringify({ narration: "x", outcome: "success", choices: ["a", "b", "c"], effects: { hp: -50, xp: 500, gold: 900, danger: 0 }, stateChanges: { inventory: [{ op: "add", ref: "", name: "Пистолет", kind: "weapon", quantity: 1 }] } })).payload;
  const fail = applyResolution(baseInput({ payload, dice: { d20: 1, modifier: 0, total: 1, dc: 12, success: false, critical: "fumble", skill: "x", label: "", kind: "d20", band: "fail" } }));
  assert.equal(fail.outcome, "failure");
  assert.equal(fail.applied.inventory[0].ok, false);
  assert.ok(fail.applied.hp <= -2 && fail.applied.hp >= -20);
  const narr = applyResolution(baseInput({ payload, rulesProfile: "narrative" }));
  assert.equal(narr.applied.hp, 0);
  assert.equal(narr.applied.xp, 0);
  assert.equal(narr.applied.gold, 0);
  assert.equal(narr.applied.inventory[0].ok, true);
});

test("reducer: переход в новую локацию создаёт узел и синхронизирует world.currentLocation (RES-1g)", () => {
  const payload = parseResolution(JSON.stringify({ narration: "x", outcome: "success", choices: ["a", "b", "c"], effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: { location: { action: "move", name: "Порт", description: "Туман" }, quests: [{ ref: "main", title: "", status: "unchanged", progress: 40 }], npcs: [{ ref: "", name: "Марта", role: "бармен", relationDelta: 80, status: "alive" }] } })).payload;
  const r = applyResolution(baseInput({ payload }));
  assert.equal(r.world.currentLocation, "Порт");
  assert.ok(r.ops.some((o) => o.t === "loc.insert"));
  assert.equal(r.applied.quests[0].progress, 40);
  assert.equal(r.applied.npcs[0].relation, 30); // кламп relationDelta по профилю
  assert.ok(r.events.some((e) => e.entityKey === "location:порт"));
  assert.ok(r.events.some((e) => e.entityKey === "npc:марта"));
});

test("reducer: завершённый квест нельзя переоткрыть; мёртвый NPC не меняется", () => {
  const payload = parseResolution(JSON.stringify({ narration: "x", outcome: "neutral", choices: ["a", "b", "c"], effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: { quests: [{ ref: "main", title: "", status: "active", progress: 10 }], npcs: [{ ref: "боб", name: "Боб", relationDelta: 10, status: "alive" }] } })).payload;
  const r = applyResolution(
    baseInput({
      payload,
      quests: [{ id: "q1", key: "main", title: "Найти брата", status: "completed", progress: 100, isMain: true, description: "" }],
      npcs: [{ id: "n1", key: "боб", name: "Боб", role: "", relation: 0, status: "dead", description: "" }],
    }),
  );
  assert.equal(r.ops.length, 0);
  assert.equal(r.applied.rejected.length, 2);
});

test("dice: детерминированные броски и 2d6-полосы", () => {
  const crit = rollD20("x", 0, 15, () => 0.999);
  assert.equal(crit.critical, "crit");
  assert.equal(crit.success, true);
  const fumble = rollD20("x", 5, 5, () => 0);
  assert.equal(fumble.success, false);
  const full = roll2d6("риск", 0, () => 0.99);
  assert.equal(full.band, "full");
  const fail = roll2d6("риск", 0, () => 0);
  assert.equal(fail.band, "fail");
  assert.equal(assessRisk("тихо осматриваю комнату", 10), "safe");
  assert.equal(assessRisk("атакую охранника", 80), "desperate");
});

test("daily limits: пропускаем исчерпанные модели с учётом числа ключей", () => {
  const r = filterByDailyLimits(["gemini-3.8-flash", "gemini-3.5-flash-lite"], { "gemini-3.8-flash": 40, "gemini-3.5-flash-lite": 10 }, { flash: 20, lite: 500 }, 2);
  assert.deepEqual(r.skipped, ["gemini-3.8-flash"]);
  assert.deepEqual(r.allowed, ["gemini-3.5-flash-lite"]);
});

test("extractor: факт без цитаты-доказательства отбрасывается", () => {
  const narration = "Марта тихо сказала, что её брат служил в порту и пропал в марте.";
  const facts = normalizeExtractedFacts(
    { facts: [
      { type: "npc", entityKey: "npc:марта", title: "Брат Марты", content: "Брат Марты служил в порту и пропал в марте.", evidence: "её брат служил в порту и пропал в марте", importance: 70, confidence: 0.9 },
      { type: "npc", entityKey: "npc:марта", title: "Галлюцинация", content: "Марта — тайный агент короны.", evidence: "тайный агент короны", importance: 70, confidence: 0.9 },
    ] },
    narration,
    "спрашиваю Марту о брате",
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0].entityKey, "npc:марта");
});

test("utils: slugify и cosine", () => {
  assert.equal(slugify("Бар «Ржавый якорь»!"), "бар-ржавый-якорь");
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});
