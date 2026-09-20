import test from "node:test";
import assert from "node:assert/strict";
import { guardNarrative, hasNarrativeStateChanges } from "../src/lib/narrative-guard";
import { emptyChanges } from "../src/lib/resolution";
import type { NarrativeVerification } from "../src/lib/narrative-verifier";

const verdict = (status: NarrativeVerification["status"]): NarrativeVerification => ({ status, provider: "openrouter", model: "typesafe/jev-1.13", answers: {}, latencyMs: 1 });
const input = () => ({ action: "Попросить штаны", narration: "Ты получил штаны.", choices: ["Надеть штаны"], declaration: { mode: "event", referencesPast: false }, hasDice: true, hasStateChanges: true, rejected: ["не получен"], state: { accepted_changes: { inventory: [] } }, emittedPrefix: "", remainingMs: () => 20000 });

test("rejected draft is repaired once against frozen state and choices change together", async () => {
  let checks = 0, repairs = 0;
  const accepted = input();
  const result = await guardNarrative({ ...accepted, verify: async state => { checks++; assert.deepEqual(state.accepted_changes, accepted.state.accepted_changes); return verdict(checks === 1 ? "rejected" : "verified"); }, repair: async () => { repairs++; return { narration: "Тебе отказали.", choices: ["Уйти"] }; } });
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.narration, "Тебе отказали."); assert.deepEqual(result.choices, ["Уйти"]); }
  assert.equal(checks, 2); assert.equal(repairs, 1);
});

test("unavailable verifier and expired deadline cannot publish a critical draft", async () => {
  for (const status of ["unavailable", "uncertain"] as const) {
    const result = await guardNarrative({ ...input(), verify: async () => verdict(status), repair: async () => null });
    assert.equal(result.ok, false);
  }
  let called = false;
  const result = await guardNarrative({ ...input(), remainingMs: () => 0, verify: async () => { called = true; return verdict("verified"); }, repair: async () => null });
  assert.equal(result.ok, false); assert.equal(called, false);
});

test("late escalation cannot replace already emitted prose with a different story", async () => {
  const result = await guardNarrative({ ...input(), emittedPrefix: "Туман. ", narration: "Туман. Ты получил штаны.", verify: async () => verdict("rejected"), repair: async () => ({ narration: "Ясное небо. Тебе отказали.", choices: [] }) });
  assert.equal(result.ok, false);
});

test("repair cannot manufacture evidence for a supposedly independent acquisition", async () => {
  let repairs = 0;
  for (const choice of ["contradicts", "insufficient"] as const) {
    const result = await guardNarrative({ ...input(), hasProvisionalIndependentAdds: true,
      verify: async () => ({ ...verdict("uncertain"), answers: { independent_acquisitions: {
        choice, confidence: .99, probabilities: { consistent: .01, contradicts: choice === "contradicts" ? .98 : .01, insufficient: choice === "insufficient" ? .98 : .01 },
      } } }), repair: async () => { repairs++; return { narration: "Якобы независимый подарок.", choices: [] }; } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "independence_not_verified");
  }
  assert.equal(repairs, 0);
});

test("empty proposal is still material when reducer adds XP or flags change", () => {
  const payload = { stateChanges: emptyChanges(), effects: { hp: 0, xp: 0, gold: 0, danger: 0 } };
  assert.equal(hasNarrativeStateChanges(payload), false);
  assert.equal(hasNarrativeStateChanges(payload, { xp: 10 }), true);
  payload.stateChanges.flags = { contract: "district" };
  assert.equal(hasNarrativeStateChanges(payload), true);
  payload.stateChanges.flags = { locked: false };
  assert.equal(hasNarrativeStateChanges(payload), true);
  payload.stateChanges.flags = { debt: 0 };
  assert.equal(hasNarrativeStateChanges(payload), true);
});

test("repair and verifier cannot mutate the authoritative reducer snapshot", async () => {
  const accepted = input();
  let checks = 0;
  const result = await guardNarrative({ ...accepted,
    verify: async state => {
      assert.deepEqual(state.accepted_changes, { inventory: [] });
      (state.accepted_changes as { inventory: string[] }).inventory.push("injected");
      return verdict(++checks === 1 ? "rejected" : "verified");
    },
    repair: async state => {
      assert.deepEqual(state.accepted_changes, { inventory: [] });
      (state.accepted_changes as { inventory: string[] }).inventory.push("pants");
      return { narration: "Тебе отказали.", choices: ["Уйти"] };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(accepted.state.accepted_changes, { inventory: [] });
});

test("a verified response arriving after the deadline cannot authorize saving", async () => {
  let remaining = 10000;
  const result = await guardNarrative({ ...input(), remainingMs: () => remaining,
    verify: async () => { remaining = 0; return verdict("verified"); }, repair: async () => null });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "deadline");
});

test("plain description skips remote calls, whereas provider exceptions fail closed", async () => {
  const verify = async () => { throw new Error("private provider error"); };
  const safe = await guardNarrative({ ...input(), action: "Посмотреть на небо", narration: "Серый туман.",
    declaration: { mode: "description", referencesPast: false }, hasDice: false, hasStateChanges: false,
    rejected: [], choices: ["Осмотреться"], verify, repair: async () => null });
  assert.equal(safe.ok, true);
  assert.equal(safe.checks.length, 0);
  const unsafe = await guardNarrative({ ...input(), verify, repair: async () => null });
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) assert.equal(unsafe.reason, "verification_failed");
});

test("empty scopes are omitted, then repaired choices are checked without losing historical checks", async () => {
  let calls = 0;
  const result = await guardNarrative({ ...input(), choices: [], state: { accepted_changes: { agreements: [] } },
    verify: async (_state, selection) => {
      calls++;
      assert.equal(!!selection.questions.choices, calls === 2);
      assert.equal(selection.questions.agreements, undefined);
      assert.ok(selection.questions.history_object);
      assert.ok(selection.questions.unlisted_events);
      return verdict(calls === 1 ? "rejected" : "verified");
    }, repair: async () => ({ narration: "Тебе отказали.", choices: ["Попробовать ещё раз"] }),
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(result.checkSelections.length, 2);
  assert.equal(result.checkSelections[0].questions.choices, undefined);
  assert.ok(result.checkSelections[1].questions.choices);
});

test("unknown or nonempty agreement scope retains the agreement check", async () => {
  for (const agreements of [undefined, null, {}, [{ object: "район" }]]) {
    let checked = false;
    const result = await guardNarrative({ ...input(), state: { accepted_changes: { agreements } },
      verify: async (_state, selection) => { checked = true; assert.ok(selection.questions.agreements); return verdict("verified"); }, repair: async () => null });
    assert.equal(result.ok, true);
    assert.equal(checked, true);
  }
});

test("an optional review can resolve uncertainty against the same frozen draft without repair", async () => {
  let reviews = 0, repairs = 0;
  const result = await guardNarrative({ ...input(), verify: async () => verdict("uncertain"),
    review: async (state, selection) => {
      reviews++;
      assert.equal(state.draft, input().narration);
      assert.ok(selection.questions.outcome);
      (state.accepted_changes as { inventory: string[] }).inventory.push("mutated");
      return { model: "test-reviewer", latencyMs: 1, text: JSON.stringify({ answers: Object.keys(selection.questions).map(id => ({ id, verdict: "consistent", reason: "Synthetic approval", evidence: [{ path: "/draft", quote: input().narration }] })) }) };
    }, repair: async () => { repairs++; return null; } });
  assert.equal(result.ok, true);
  assert.equal(reviews, 1); assert.equal(repairs, 0);
  assert.equal(result.reviews[0].attempt, 0);
});

test("review does not override a confident rejection or rescue an expired deadline", async () => {
  let reviews = 0, remaining = 20000;
  const review = async () => { reviews++; remaining = 0; return { model: "test-reviewer", latencyMs: 1, text: '{"answers":[]}' }; };
  const rejected = await guardNarrative({ ...input(), verify: async () => verdict("rejected"), review, repair: async () => null });
  assert.equal(rejected.ok, false); assert.equal(reviews, 0);
  const expired = await guardNarrative({ ...input(), remainingMs: () => remaining, verify: async () => verdict("uncertain"), review, repair: async () => null });
  assert.equal(expired.ok, false); assert.equal(reviews, 1);
});

test("malformed review cannot approve and its rejection is supplied to the single repair", async () => {
  let repairs = 0;
  const invalid = await guardNarrative({ ...input(), verify: async () => verdict("uncertain"),
    review: async () => ({ model: "test", latencyMs: 1, text: '{"answers":[]}' }),
    repair: async () => { repairs++; return null; } });
  assert.equal(invalid.ok, false); assert.equal(repairs, 0);
  let checks = 0;
  const repaired = await guardNarrative({ ...input(), verify: async () => verdict(++checks === 1 ? "uncertain" : "verified"),
    review: async (_state, selection) => ({ model: "test", latencyMs: 1,
      text: JSON.stringify({ answers: Object.keys(selection.questions).map(id => ({ id, verdict: id === "outcome" ? "contradicts" : "consistent", reason: "Отказ не описан", evidence: [{ path: "/draft", quote: input().narration }] })) }) }),
    repair: async (_state, _report, _prefix, review) => {
      assert.equal(review?.status, "rejected"); repairs++;
      return { narration: "Тебе отказали.", choices: [] };
    } });
  assert.equal(repaired.ok, true); assert.equal(repairs, 1); assert.equal(checks, 2);
});

test("both uncertain drafts get separate reviews with exactly one repair", async () => {
  let reviews = 0, repairs = 0;
  const result = await guardNarrative({ ...input(), verify: async () => verdict("uncertain"),
    review: async (state, selection) => {
      reviews++;
      assert.equal(state.draft, reviews === 1 ? input().narration : "Тебе отказали.");
      return { model: "test", latencyMs: 1, text: JSON.stringify({ answers: Object.keys(selection.questions).map(id => ({ id,
        verdict: reviews === 1 && id === "outcome" ? "contradicts" : "consistent", reason: "Synthetic review",
        evidence: [{ path: "/draft", quote: state.draft }],
      })) }) };
    }, repair: async () => { repairs++; return { narration: "Тебе отказали.", choices: [] }; } });
  assert.equal(result.ok, true); assert.equal(reviews, 2); assert.equal(repairs, 1);
  assert.deepEqual(result.reviews.map(r => r.attempt), [0, 1]);
  assert.deepEqual(result.reviews.map(r => r.result.status), ["rejected", "verified"]);
  assert.equal(result.checks.length, 2);
});
