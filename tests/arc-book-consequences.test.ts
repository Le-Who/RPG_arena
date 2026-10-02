import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppliedChanges, WorldState } from "../src/db/schema";
import { buildLifePromptBlock, continueStory, readArcHistory, readLife } from "../src/lib/world-life";
import { markdownToBookHtml } from "../src/lib/campaign-book";
import { describeAppliedChanges, describeConsequences } from "../src/lib/applied-changes";

const world = (patch: Partial<WorldState> = {}): WorldState => ({
  worldName: "Город", tone: "драма", era: "наши дни", mainQuest: "Найти брата", currentLocation: "Дом",
  factions: [], flags: {}, danger: 0, chapter: 3, clock: { day: 4, minute: 10 * 60 }, ...patch,
});
const resolved = world({ story: { kind: "arc", goal: "Найти брата", stakes: "семья", conflict: "", endCondition: "брат найден", focus: [], status: "resolved", resolvedTurn: 40, epilogue: "Они вернулись домой." } });
const applied = (patch: Partial<AppliedChanges> = {}): AppliedChanges => ({
  hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [],
  conditions: { added: [], removed: [] }, rejected: [], ...patch,
});

test("arc archive retains the latest 32 summaries without mutating prior world", () => {
  const records = Array.from({ length: 32 }, (_, i) => ({ goal: `Арка ${i}`, stakes: "", conflict: "", endCondition: "", epilogue: "Итог", resolvedTurn: i + 1, closedTurn: i + 1, closedAt: { day: 1, minute: i } }));
  const previous = { ...resolved, arcHistory: records };
  const before = structuredClone(previous);
  const result = continueStory(previous, { continueAs: "open-life" }, 41);
  assert.ok(result.ok);
  const archive = readArcHistory(result.world);
  assert.equal(archive.length, 32);
  assert.equal(archive[0].goal, "Арка 1");
  assert.equal(archive.at(-1)?.goal, "Найти брата");
  assert.deepEqual(previous, before);
});

test("NARR-9b: continuing after a resolved arc keeps it as canon and starts the chosen shape", () => {
  assert.equal(continueStory(world(), { continueAs: "open-life" }, 41).ok, false, "an ongoing arc cannot be continued");
  assert.equal(continueStory(resolved, { continueAs: "epic" }, 41).ok, false);
  const life = continueStory(resolved, { continueAs: "open-life", focus: "обустроить дом\nнайти работу" }, 41);
  assert.ok(life.ok);
  if (!life.ok) return;
  const shape = readLife(life.world).story;
  assert.deepEqual([shape.kind, shape.status, shape.focus], ["open-life", "ongoing", ["обустроить дом", "найти работу"]]);
  const [arc] = readArcHistory(life.world);
  assert.deepEqual([arc.goal, arc.epilogue, arc.resolvedTurn, arc.closedTurn, arc.closedAt], ["Найти брата", "Они вернулись домой.", 40, 41, { day: 4, minute: 600 }]);
  assert.match(buildLifePromptBlock(life.world, "act", ""), /ЗАВЕРШЁННЫЕ АРКИ \(канон, не переигрывай\): "Найти брата" — ход 40/);
  assert.equal(continueStory(resolved, { continueAs: "arc", goal: " " }, 41).ok, false, "a new arc needs a goal");
  const next = continueStory(resolved, { continueAs: "arc", goal: "Открыть пекарню", stakes: "сбережения", conflict: "конкуренция", endCondition: "первый покупатель" }, 41);
  assert.ok(next.ok && readLife(next.world).story.goal === "Открыть пекарню" && readLife(next.world).story.status === "ongoing");
});

test("ECO-1c: the offline book escapes content, has a table of contents and no active content", () => {
  const html = markdownToBookHtml("# Хроника <Ады>\n\n## Глава 1\n\nАда вошла. <script>alert(1)</script> **смело**\n\n> цитата\n\n- пункт\n\n## Глава 2\n\nКонец.", { exportedAt: new Date("2026-09-27T00:00:00Z") });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<title>Хроника &lt;Ады&gt;<\/title>/);
  assert.match(html, /<nav aria-label="Содержание">[\s\S]*Глава 1[\s\S]*Глава 2/);
  assert.match(html, /<strong>смело<\/strong>/);
  assert.match(html, /<blockquote>цитата<\/blockquote>/);
  assert.match(html, /<ul><li>пункт<\/li><\/ul>/);
  assert.match(html, /Экспортировано из Chronicle Engine 2026-09-27/);
  assert.ok(!/src=|href="https?:|<link|<iframe/i.test(html));
});

test("NARR-3: consequences explain before → after and why; chips show missed meetings and rescheduling", () => {
  const changes = applied({
    npcs: [{ name: "Анна", relation: 15, delta: 5, status: "alive", isNew: false, note: "помог с мукой" }],
    conditions: { added: [], removed: ["напуган"] }, conditionTimers: { expired: ["напуган"], scheduled: [] },
    life: { intent: "act", clock: null, commitments: [{ title: "Ужин", status: "accepted", isNew: false, rescheduled: true }], transfers: [], story: null },
    social: { bonds: [], schedules: [{ name: "Анна", place: "Пекарня", window: "07:00–15:00, ежедневно" }], knowledge: [], missed: [{ title: "Встреча в порту", parties: ["Олег"], penalty: 5 }], overdue: [] },
  });
  const rows = describeConsequences(changes);
  assert.deepEqual(rows[0], { group: "Отношения", subject: "Анна", before: "+10", after: "+15", reason: "помог с мукой" });
  assert.ok(rows.some((row) => row.subject === "напуган" && row.reason === "прошло со временем"));
  assert.ok(rows.some((row) => row.subject === "Ужин" && row.after === "перенесено"));
  assert.ok(rows.some((row) => row.after === "неявка" && /отношения −5/.test(row.reason)));
  const labels = describeAppliedChanges(changes).map((chip) => chip.label);
  assert.ok(labels.includes("Неявка: Встреча в порту · отношения −5 (Олег)"));
  assert.ok(labels.includes("Договорённость: Ужин — перенесено"));
  assert.ok(labels.includes("Распорядок: Анна — «Пекарня», 07:00–15:00, ежедневно"));
});
