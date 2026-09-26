import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorldState } from "../src/db/schema";
import { applyLife, advanceClock, classifyIntent, commitmentAlerts, emptyLifeChanges, formatClock, gateByIntent, normalizeStoryShape, parseLifeChanges, readLife, type LifeChanges } from "../src/lib/world-life";
import { checkInteraction, inferInteraction, interactionText, availableActions, type InteractionState } from "../src/lib/interactions";
import { emptyChanges, parseResolution, RESOLUTION_RESPONSE_SCHEMA, type ResolutionPayload } from "../src/lib/resolution";
import { describeAppliedChanges } from "../src/lib/applied-changes";
import { buildVisualPrompt, fetchFromProvider, pollinationsProvider, seedFor, visualConfig } from "../src/lib/visual-provider";

const world = (patch: Partial<WorldState> = {}): WorldState => ({ worldName: "Город", tone: "повседневность", era: "наши дни", mainQuest: "Найти работу", currentLocation: "Кафе", factions: [], flags: {}, danger: 0, chapter: 1, ...patch });
const book = { id: "11111111-aaaa-4aaa-8aaa-111111111111", name: "Книга стихов", kind: "misc", quantity: 1, equipped: false, description: "Потрёпанный томик", icon: "📘", power: 0 };
const anna = { id: "n1", key: "anna", name: "Анна", role: "подруга", relation: 10, status: "alive" as const, description: "", lastLocation: "Кафе" };
const boris = { id: "n2", key: "boris", name: "Борис", role: "сосед", relation: 0, status: "alive" as const, description: "", lastLocation: "Дом" };
const locs = [
  { id: "l1", name: "Кафе", x: 0, y: 0, current: true, discovered: true, danger: 0, connectedTo: ["l2"] },
  { id: "l2", name: "Парк", x: 1, y: 0, current: false, discovered: true, danger: 0, connectedTo: ["l1"] },
  { id: "l3", name: "Вокзал", x: 2, y: 0, current: false, discovered: true, danger: 0, connectedTo: [] },
];
const life = (patch: Partial<LifeChanges>): LifeChanges => ({ ...emptyLifeChanges(), ...patch });
const base = (patch: Partial<Parameters<typeof applyLife>[0]> = {}) => applyLife({
  world: world(), inventory: [book], npcs: [anna, boris], locations: locs, life: emptyLifeChanges(), intent: "act",
  defaultMinutes: 5, turnNumber: 3, touchedItemIds: new Set(), mainQuestCompleted: false, makeId: () => "id1", ...patch,
});

test("old campaigns read safe defaults for clock, story shape, commitments and holdings", () => {
  const l = readLife(world());
  assert.deepEqual(l.clock, { day: 1, minute: 540 });
  assert.equal(l.story.kind, "arc");
  assert.equal(l.story.goal, "Найти работу");
  assert.deepEqual([l.commitments, l.holdings], [[], []]);
  assert.equal(readLife(world({ mainQuest: "" })).story.kind, "open-life");
  assert.equal(normalizeStoryShape({ kind: "weird" }, { mainQuest: "" }).kind, "open-life");
});

test("clock advances across days and formats part of day", () => {
  assert.deepEqual(advanceClock({ day: 1, minute: 23 * 60 }, 120), { day: 2, minute: 60 });
  assert.equal(formatClock({ day: 2, minute: 18 * 60 + 5 }), "День 2, 18:05 (вечер)");
});

test("intent classifier separates action, intention, claim and question", () => {
  assert.equal(classifyIntent("Открыть дверь"), "act");
  assert.equal(classifyIntent("Я хочу открыть дверь"), "act");
  assert.equal(classifyIntent("Хочу подарить книгу Анне"), "intend");
  assert.equal(classifyIntent("Завтра позвоню Борису"), "intend");
  assert.equal(classifyIntent("Я получил работу в офисе"), "claim");
  assert.equal(classifyIntent("Она согласилась на встречу"), "claim");
  assert.equal(classifyIntent("Что лежит на столе?"), "ask");
});

test("accepted transfer moves the item to a present NPC once, with memory and holding", () => {
  const r = base({ life: life({ transfers: [{ ref: book.id, to: "anna", quantity: 1, accepted: true }] }) });
  assert.deepEqual(r.ops, [{ t: "inv.delete", id: book.id }]);
  assert.equal(r.applied.transfers[0].ok, true);
  const holdings = readLife(r.world).holdings;
  assert.equal(holdings[0].holderName, "Анна");
  assert.ok(r.events.some((e) => e.entityKey === "holding:книга стихов"));
});

test("an item added back to the hero clears its holding record", () => {
  const given = base({ life: life({ transfers: [{ ref: book.id, to: "anna", quantity: 1, accepted: true }] }) });
  const back = base({ world: given.world, inventory: [], addedItemNames: ["Книга стихов"] });
  assert.equal(readLife(back.world).holdings.length, 0);
  assert.ok(back.events.some((e) => e.title.includes("снова у героя")));
});

test("intention, refusal, missing item and double-touch never deduct the item", () => {
  const transfer = { ref: book.id, to: "anna", quantity: 1, accepted: true };
  assert.equal(base({ intent: "intend", life: life({ transfers: [transfer] }) }).ops.length, 0);
  assert.equal(base({ life: life({ transfers: [{ ...transfer, accepted: false }] }) }).ops.length, 0);
  assert.equal(base({ life: life({ transfers: [{ ...transfer, ref: "nope" }] }) }).ops.length, 0);
  assert.equal(base({ touchedItemIds: new Set([book.id]), life: life({ transfers: [transfer] }) }).ops.length, 0);
  const dropped = base({ life: life({ transfers: [{ ...transfer, to: "Парк" }] }) });
  assert.equal(dropped.ops.length, 0, "can only leave items at the current location");
});

test("claimed agreements stay proposals; accepted ones get deadlines and alerts", () => {
  const claimed = base({ intent: "claim", life: life({ commitments: [{ ref: null, title: "Работа в офисе", parties: ["Борис"], place: "Офис", day: null, time: "", status: "accepted", note: "" }] }) });
  assert.equal(readLife(claimed.world).commitments[0].status, "proposed");
  assert.equal(claimed.applied.commitments[0].downgraded, true);
  const accepted = base({ life: life({ commitments: [{ ref: null, title: "Встреча в кафе", parties: ["Анна"], place: "Кафе", day: 1, time: "10:00", status: "accepted", note: "" }] }) });
  const state = readLife(accepted.world);
  assert.equal(state.commitments[0].status, "accepted");
  assert.deepEqual(state.commitments[0].due, { day: 1, minute: 600 });
  assert.equal(commitmentAlerts({ ...state, clock: { day: 1, minute: 560 } }).due.length, 1);
  assert.equal(commitmentAlerts({ ...state, clock: { day: 1, minute: 640 } }).overdue.length, 0);
  assert.equal(commitmentAlerts({ ...state, clock: { day: 1, minute: 700 } }).overdue.length, 1);
});

test("an invalid commitment time is rejected instead of silently becoming noon", () => {
  const result = base({ life: life({ commitments: [{ ref: null, title: "Неверное время", parties: [], place: "", day: 2, time: "99:99", status: "accepted", note: "" }] }) });
  assert.equal(readLife(result.world).commitments.length, 0);
  assert.match(result.rejected.join(" "), /время|формат/i);
});

test("story shape drives chapter boundaries and arc resolution", () => {
  const arc = base({ mainQuestCompleted: true, life: life({ story: { status: null, epilogue: "" } }) });
  assert.equal(readLife(arc.world).story.status, "resolved");
  assert.equal(arc.chapterBoundary, true);
  const claimedEnd = base({ intent: "claim", life: life({ story: { status: "resolved", epilogue: "" } }) });
  assert.equal(readLife(claimedEnd.world).story.status, "ongoing");
  const openLife = world({ story: { kind: "open-life", goal: "", stakes: "", conflict: "", endCondition: "", focus: [], status: "ongoing" }, clock: { day: 1, minute: 23 * 60 } });
  assert.equal(base({ world: openLife, life: life({ advanceMinutes: 90 }) }).chapterBoundary, true);
  assert.equal(base({ world: openLife, life: life({ advanceMinutes: 10 }) }).chapterBoundary, false);
  assert.equal(base({ world: world({ story: { kind: "scene", goal: "", stakes: "", conflict: "", endCondition: "", focus: [], status: "ongoing" } }) }).chapterBoundary, false);
});

test("resolution schema and parser carry life changes", () => {
  const props = ((RESOLUTION_RESPONSE_SCHEMA.properties as Record<string, { properties: Record<string, unknown> }>).stateChanges).properties;
  assert.ok(props.time && props.commitments && props.transfers && props.story);
  const parsed = parseResolution(JSON.stringify({ narration: "x", outcome: "success", choices: ["a"], effects: { hp: 0, xp: 0, gold: 0, danger: 0 },
    stateChanges: { time: { advanceMinutes: 99999 }, transfers: [{ ref: "#abc", to: "anna", accepted: true }], commitments: [{ ref: "", title: "Ужин", status: "proposed", day: 2, time: "19:30" }], story: { status: "resolved" } } }));
  assert.equal(parsed.payload.life?.advanceMinutes, 10080);
  assert.equal(parsed.payload.life?.transfers[0].ref, "abc");
  assert.equal(parsed.payload.life?.commitments[0].day, 2);
  assert.deepEqual(parseLifeChanges({}), emptyLifeChanges());
});

test("claims cannot complete quests; questions do not move or spend", () => {
  const payload: ResolutionPayload = { narration: "", outcome: "success", choices: [], effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: { ...emptyChanges(), quests: [{ ref: "job", title: "Работа", status: "completed", progress: 100, note: "" }], location: { action: "move", ref: null, name: "Парк", description: "", danger: null } } };
  assert.equal(gateByIntent(payload, "claim").length, 1);
  assert.equal(payload.stateChanges.quests.length, 0);
  assert.equal(gateByIntent(payload, "ask").length, 1);
  assert.equal(payload.stateChanges.location, null);
});

const state: InteractionState = { currentLocation: "Кафе", inventory: [book], npcs: [anna, boris], sceneObjects: [{ key: "door", name: "Дверь подсобки", state: "заперта", locationName: "Кафе" }], locations: locs, holdings: [] };

test("button text and free text resolve to the same interaction contract", () => {
  const button = { verb: "give" as const, target: { kind: "item" as const, ref: book.id, name: book.name }, recipient: { kind: "npc" as const, ref: "anna", name: "Анна" } };
  const parsed = inferInteraction(interactionText(button), state, [book.id]);
  assert.deepEqual(parsed, button);
  const free = inferInteraction("подарить книгу стихов Анне", state);
  assert.equal(free?.verb, "give");
  assert.equal(free?.target.ref, book.id);
  assert.equal(free?.recipient?.ref, "anna");
  assert.equal(inferInteraction("Подождать 2 часа", state)?.minutes, 120);
  assert.equal(inferInteraction("Лечь спать до утра", state)?.minutes, 480);
  assert.equal(inferInteraction("Открыть дверь подсобки", state)?.target.ref, "door");
});

test("server availability checks: presence, ownership, reachability", () => {
  assert.equal(checkInteraction(inferInteraction("Поговорить с «Анна»", state), state).valid, true);
  const absent = checkInteraction(inferInteraction("Поговорить с «Борис»", state), state);
  assert.equal(absent.valid, false);
  assert.match(absent.reasons[0], /не рядом/);
  assert.equal(checkInteraction(inferInteraction("Отправиться в «Парк»", state), state).valid, true);
  assert.equal(checkInteraction(inferInteraction("Отправиться в «Вокзал»", state), state).valid, false);
  assert.equal(checkInteraction({ verb: "give", target: { kind: "item", ref: book.id, name: book.name }, recipient: { kind: "npc", ref: "boris", name: "Борис" } }, state).valid, false);
  assert.equal(checkInteraction({ verb: "use", target: { kind: "item", ref: "missing", name: "Меч" } }, state).valid, false);
  assert.equal(checkInteraction(inferInteraction("Подождать 45 мин", state), state).defaultMinutes, 45);
  assert.deepEqual(availableActions("npc", "boris", state).map((a) => a.enabled), [false, false, false]);
  assert.equal(availableActions("item", book.id, state).find((a) => a.verb === "give")?.enabled, true);
});

test("server rejects references to missing objects, holdings and locations", () => {
  assert.equal(checkInteraction({ verb: "open", target: { kind: "object", ref: "missing", name: "Несуществующая дверь" } }, state).valid, false);
  assert.equal(checkInteraction({ verb: "take", target: { kind: "holding", ref: "missing:Книга", name: "Книга" } }, state).valid, false);
  assert.equal(checkInteraction({ verb: "move", target: { kind: "location", ref: "missing", name: "Несуществующий город" } }, state).valid, false);
});

test("a transfer requires the recipient to be present in the current location", () => {
  const away = [{ ...anna, lastLocation: "Дом" }];
  const result = base({ npcs: away, life: life({ transfers: [{ ref: book.id, to: "anna", quantity: 1, accepted: true }] }) });
  assert.equal(result.ops.length, 0);
  assert.equal(result.applied.transfers[0].ok, false);
  assert.match(result.applied.transfers[0].reason ?? "", /рядом|месте/);
});

test("returning one item decrements a larger holding instead of erasing it", () => {
  const worldWithHolding = world({ holdings: [{ id: "h1", name: book.name, description: book.description, quantity: 3, holderKind: "npc", holderKey: "anna", holderName: "Анна", turn: 1 }] });
  const result = base({ world: worldWithHolding, inventory: [], addedItemNames: [book.name] });
  assert.equal(readLife(result.world).holdings[0]?.quantity, 2);
});

test("applied change chips describe life consequences", () => {
  const r = base({ life: life({ advanceMinutes: 24 * 60, transfers: [{ ref: book.id, to: "anna", quantity: 1, accepted: true }] }) });
  const labels = describeAppliedChanges({ hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, inventory: [], quests: [], npcs: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [], life: r.applied }).map((c) => c.label);
  assert.ok(labels.some((l) => l.includes("«Книга стихов» → Анна")));
  assert.ok(labels.some((l) => l.startsWith("Новый день")));
});

test("visual prompts are bounded, contain no service IDs and seeds are stable", () => {
  const prompt = buildVisualPrompt({ kind: "scene", world: world(), subjectName: "Кафе", passport: "", sceneNarration: "x".repeat(5000), presentPassports: [{ name: "Анна", passport: "рыжие волосы" }] });
  assert.ok(prompt.length <= 900);
  assert.doesNotMatch(prompt, /[0-9a-f]{8}-[0-9a-f]{4}/);
  assert.equal(seedFor("s", "hero"), seedFor("s", "hero"));
  assert.notEqual(seedFor("s", "hero"), seedFor("s", "npc:anna"));
  const saved = process.env.POLLINATIONS_API_KEY;
  try {
    delete process.env.POLLINATIONS_API_KEY;
    assert.equal(visualConfig().authenticated, false);
    assert.equal(visualConfig().model, "tongyi-mai/z-image-turbo");
    assert.throws(() => pollinationsProvider.buildRequest({ prompt: "a b", seed: 1, width: 10, height: 10, model: "tongyi-mai/z-image-turbo" }), /POLLINATIONS_KEY_REQUIRED/);
    process.env.POLLINATIONS_API_KEY = "k";
    const auth = pollinationsProvider.buildRequest({ prompt: "a", seed: 1, width: 10, height: 10, model: "tongyi-mai/z-image-turbo" });
    assert.match(auth.url, /^https:\/\/gen\.pollinations\.ai\/image\//);
    assert.match(auth.url, /model=tongyi-mai%2Fz-image-turbo/);
    assert.equal(auth.headers.Authorization, "Bearer k");
  } finally { if (saved === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = saved; }
});

test("provider responses must be real images of bounded size", async () => {
  const saved = process.env.POLLINATIONS_API_KEY;
  process.env.POLLINATIONS_API_KEY = "test";
  try {
  const req = { prompt: "a", seed: 1, width: 10, height: 10, model: "tongyi-mai/z-image-turbo" };
  const fake = (body: BodyInit, type: string, status = 200) => (async () => new Response(body, { status, headers: { "content-type": type } })) as unknown as typeof fetch;
  await assert.rejects(fetchFromProvider(pollinationsProvider, req, fake("<html>", "text/html")), /PROVIDER_NOT_IMAGE/);
  await assert.rejects(fetchFromProvider(pollinationsProvider, req, fake("x", "image/png", 429)), /PROVIDER_HTTP_429/);
  const ok = await fetchFromProvider(pollinationsProvider, req, fake(new Uint8Array([1, 2, 3]), "image/jpeg"));
  assert.equal(ok.mimeType, "image/jpeg");
  assert.equal(ok.image.length, 3);
  await assert.rejects(fetchFromProvider(pollinationsProvider, req, (async () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png", "content-length": String(9 * 1024 * 1024) } })) as unknown as typeof fetch), /PROVIDER_BAD_SIZE/);
  } finally { if (saved === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = saved; }
});
