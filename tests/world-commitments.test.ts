import test from "node:test";
import assert from "node:assert/strict";
import { portableFixture } from "./helpers/portable-fixture";
import { readLife, type Commitment } from "../src/lib/world-life";
import { commitmentVersion, parseCommitmentEdit, resolveCommitment } from "../src/lib/world-commitments";

const meeting = (patch: Partial<Commitment> = {}): Commitment => ({ id: "c1", title: "Встреча", parties: ["Мира"], place: "Кафе", due: { day: 1, minute: 660 }, status: "accepted", createdTurn: 1, updatedTurn: 2, note: "", ...patch });
const worldWith = (c: Commitment) => ({ ...portableFixture().session.worldState, clock: { day: 1, minute: 600 }, commitments: [c] });

test("owner outcomes, rescheduling and reopening preserve provenance and input", async () => {
  const current = meeting({ attendance: "present" });
  const world = worldWith(current), before = structuredClone(world);
  const version = await commitmentVersion(current);
  for (const action of ["fulfilled", "missed", "cancelled", "reschedule"] as const) {
    const result = await resolveCommitment({ world, edit: { id: "c1", version, action, day: 2, time: "18:15", note: "исправление" }, turn: 2 });
    assert.ok(result.ok);
    assert.equal(result.commitment.history?.at(-1)?.source, "owner");
    assert.equal(result.events[0].entityKey, "commitment:c1");
    assert.deepEqual(world, before);
    if (action === "reschedule") {
      assert.deepEqual(result.commitment.due, { day: 2, minute: 1095 });
      assert.equal(result.commitment.attendance, undefined);
    } else {
      const reopened = await resolveCommitment({ world: result.world, edit: { id: "c1", version: await commitmentVersion(result.commitment), action: "reopen", day: null, time: "", note: "" }, turn: 2 });
      assert.ok(reopened.ok);
      assert.equal(reopened.commitment.status, "accepted");
      assert.equal(reopened.commitment.attendance, undefined);
      assert.equal(reopened.commitment.history?.at(-1)?.kind, "reopened");
    }
  }
});

test("content versions detect changes at saturated history and within one turn", async () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ turn: 2, kind: "rescheduled" as const, from: null, to: { day: 1, minute: 660 }, note: String(i), source: "owner" as const }));
  const c = meeting({ history });
  const version = await commitmentVersion(c);
  assert.notEqual(await commitmentVersion({ ...c, history: [...history.slice(1), { ...history[11], note: "new" }] }), version);
  assert.notEqual(await commitmentVersion({ ...c, title: "Изменённая встреча" }), version);
  assert.equal(await commitmentVersion(JSON.parse(JSON.stringify(c))), version);
  const result = await resolveCommitment({ world: worldWith({ ...c, note: "new terms" }), edit: { id: "c1", version, action: "fulfilled", day: null, time: "", note: "" }, turn: 2 });
  assert.equal(result.ok ? "accepted" : result.code, "STALE_COMMITMENT");
});

test("parser bounds input and reducer rejects past times and capacity overflow", async () => {
  const c = meeting(), version = await commitmentVersion(c);
  assert.equal(parseCommitmentEdit({ id: "c1", version, action: "reschedule", day: 0, time: "09:00" }), null);
  assert.equal(parseCommitmentEdit({ id: "c1", version, action: "reschedule", day: 2, time: "24:00" }), null);
  const result = await resolveCommitment({ world: worldWith(c), edit: { id: "c1", version, action: "reschedule", day: 1, time: "09:00", note: "" }, turn: 2 });
  assert.equal(result.ok ? "accepted" : result.code, "INVALID_TIME");
  const closed = meeting({ status: "fulfilled" });
  const world = worldWith(closed);
  world.commitments.push(...Array.from({length: 16}, (_, i) => meeting({id: `other-${i}`})));
  const overflow = await resolveCommitment({ world, edit: { id: "c1", version: await commitmentVersion(closed), action: "reopen", day: null, time: "", note: "" }, turn: 2 });
  assert.equal(overflow.ok ? "accepted" : overflow.code, "INVALID_TRANSITION");
  assert.equal(readLife(world).commitments[0].status, "fulfilled");
});

test("later narrative rescheduling retains bounded owner history and labels its own source", async () => {
  const { applyLife, emptyLifeChanges } = await import("../src/lib/world-life");
  const history = Array.from({ length: 10 }, (_, i) => ({ turn: 1, kind: "reopened" as const, from: null, to: null, source: "owner" as const, note: `исправление ${i}` }));
  const c = meeting({ history });
  const world = worldWith(c), before = structuredClone(world);
  const result = applyLife({ world, inventory: [], npcs: [], locations: [], intent: "act", defaultMinutes: 0, turnNumber: 3, touchedItemIds: new Set(), mainQuestCompleted: false,
    life: { ...emptyLifeChanges(), commitments: [{ ref: "c1", title: "", parties: [], place: "", day: 2, time: "12:00", status: "accepted", note: "перенесли" }] } });
  const updated = readLife(result.world).commitments[0];
  assert.equal(updated.history?.length, 11);
  assert.equal(updated.revision, 1);
  assert.deepEqual(updated.history?.slice(0, 10), history);
  assert.equal(updated.history?.at(-1)?.source, "narration");
  assert.notEqual(await commitmentVersion(updated), await commitmentVersion(c));
  assert.deepEqual(world, before);
});

test("owner parser preserves imported Unicode and spaced identifiers exactly", async () => {
  for (const id of ["встреча-1", "meeting 1", " встреча 1 ", "я".repeat(64)]) {
    const commitment = meeting({ id });
    const edit = parseCommitmentEdit({ id, version: await commitmentVersion(commitment), action: "fulfilled" });
    assert.ok(edit);
    assert.equal(edit.id, id);
    const result = await resolveCommitment({ world: worldWith(commitment), edit, turn: 2 });
    assert.ok(result.ok);
    assert.equal(result.commitment.id, id);
  }
  for (const id of ["", " ", "я".repeat(65)]) assert.equal(parseCommitmentEdit({ id, version: "a".repeat(64), action: "fulfilled" }), null);
});

test("repeated same-turn correction cycles never revive a stale token after history saturation", async () => {
  let world = worldWith(meeting());
  let oldVersion = "";
  for (let i = 0; i < 24; i++) {
    const current = readLife(world).commitments[0];
    const result = await resolveCommitment({ world, edit: { id: current.id, version: await commitmentVersion(current), action: i % 2 ? "reopen" : "fulfilled", day: null, time: "", note: "" }, turn: 2 });
    assert.ok(result.ok);
    world = result.world as typeof world;
    if (i === 11) oldVersion = await commitmentVersion(result.commitment);
  }
  const stale = await resolveCommitment({ world, edit: { id: "c1", version: oldVersion, action: "fulfilled", day: null, time: "", note: "" }, turn: 2 });
  assert.equal(stale.ok ? "accepted" : stale.code, "STALE_COMMITMENT");
});

test("legacy revisions start at zero and the revision cap rejects owner and narrative changes", async () => {
  const { applyLife, emptyLifeChanges, MAX_COMMITMENT_REVISION } = await import("../src/lib/world-life");
  const legacy = meeting();
  assert.equal(await commitmentVersion(legacy), await commitmentVersion({ ...legacy, revision: 0 }));
  const capped = meeting({ revision: MAX_COMMITMENT_REVISION });
  const world = worldWith(capped), before = structuredClone(world);
  const result = await resolveCommitment({ world, edit: { id: "c1", version: await commitmentVersion(capped), action: "fulfilled", day: null, time: "", note: "" }, turn: 2 });
  assert.equal(result.ok ? "accepted" : result.code, "INVALID_TRANSITION");
  const narrated = applyLife({ world, inventory: [], npcs: [], locations: [], intent: "act", defaultMinutes: 0, turnNumber: 3, touchedItemIds: new Set(), mainQuestCompleted: false,
    life: { ...emptyLifeChanges(), commitments: [{ ref: "c1", title: "", parties: [], place: "", day: 2, time: "12:00", status: "fulfilled", note: "закрыли" }] } });
  assert.deepEqual(readLife(narrated.world).commitments[0], capped);
  assert.deepEqual(world, before);
});
