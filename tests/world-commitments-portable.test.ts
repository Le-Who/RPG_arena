import test from "node:test";
import assert from "node:assert/strict";
import { portableFixture } from "./helpers/portable-fixture";
import { createPortableDocument, parsePortableDocument } from "../src/lib/campaign-portable";
import { remapSnapshot } from "../src/lib/checkpoint-snapshot";
import { commitmentVersion, resolveCommitment } from "../src/lib/world-commitments";
import type { Commitment } from "../src/lib/world-life";

test("strict portable JSON and remapped snapshots retain owner correction provenance", async () => {
  const snapshot = portableFixture();
  const c: Commitment = { id: "c1", title: "Встреча", parties: ["Мира"], place: "Кафе", due: null, status: "accepted", createdTurn: 1, updatedTurn: 1, note: "" };
  const note = `Исправление записи ${snapshot.turns[0].id}`;
  const closed = await resolveCommitment({ world: { ...snapshot.session.worldState, commitments: [c] }, edit: { id: "c1", version: await commitmentVersion(c), action: "fulfilled", day: null, time: "", note }, turn: 1 });
  assert.ok(closed.ok);
  const reopened = await resolveCommitment({ world: closed.world, edit: { id: "c1", version: await commitmentVersion(closed.commitment), action: "reopen", day: null, time: "", note: "исправил" }, turn: 1 });
  assert.ok(reopened.ok);
  snapshot.session.worldState = reopened.world;
  const document = JSON.parse(JSON.stringify(createPortableDocument(snapshot)));
  const parsed = parsePortableDocument(document);
  assert.deepEqual(parsed.snapshot.session.worldState.commitments, snapshot.session.worldState.commitments);
  assert.equal(parsed.snapshot.session.worldState.commitments?.[0].revision, 2);
  const legacy = structuredClone(document);
  delete legacy.snapshot.session.worldState.commitments[0].revision;
  assert.equal(parsePortableDocument(createPortableDocument(legacy.snapshot)).snapshot.session.worldState.commitments?.[0].revision, undefined);
  for (const revision of [-1, 1.5, 1_000_000_001]) {
    const invalid = structuredClone(document);
    invalid.snapshot.session.worldState.commitments[0].revision = revision;
    assert.throws(() => parsePortableDocument(invalid), { code: "INVALID_DOCUMENT" });
  }
  const remapped = remapSnapshot(parsed.snapshot);
  assert.equal(remapped.session.worldState.commitments?.[0].revision, 2);
  assert.notEqual(remapped.turns[0].id, snapshot.turns[0].id);
  assert.deepEqual(remapped.session.worldState.commitments?.[0].history, reopened.commitment.history);
  const serialized = JSON.stringify(document);
  for (const [before, after] of [['"kind":"reopened"', '"kind":"observed"'], ['"source":"owner"', '"source":"model"'], ['"source":"owner"', '"source":"owner","invented":true']]) {
    assert.throws(() => parsePortableDocument(JSON.parse(serialized.replace(before, after))));
  }
  assert.throws(() => parsePortableDocument(JSON.parse(serialized.replace('"note":"исправил"', `"note":"${'x'.repeat(201)}"`))));
});
