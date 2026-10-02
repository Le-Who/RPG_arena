import assert from "node:assert/strict";
import test from "node:test";
import { researchCases, researchRequests, decideDualNoul } from "../scripts/jev-research-fixtures";

test("research variants retain explicit labels and do not leak them into requests", () => {
  const requests = researchRequests();
  assert.equal(requests.length, researchCases.length * 2);
  assert.equal(new Set(requests.map(r => r.id)).size, requests.length);
  for (const c of researchCases) {
    const pair = requests.filter(r => r.caseId === c.id);
    assert.equal(pair.length, 2);
    assert.equal(pair[0].expected, pair[1].expected);
    assert.equal(pair[0].body.state.claim, pair[1].body.state.claim);
    assert.deepEqual(pair[0].body.state.sources, [...pair[1].body.state.sources].reverse());
    assert.equal(Object.hasOwn(pair[0].body.state, "expected"), false);
  }
  assert.equal(new Set(researchCases.map(c => c.family)).size, 8);
  for (const label of ["supported", "contradicted", "unknown"]) assert.equal(researchCases.filter(c => c.expected === label).length, 8);
});

test("binary support never converts absence of evidence into a contradiction", () => {
  assert.equal(decideDualNoul(.01, .01), "unknown");
  assert.equal(decideDualNoul(.99, .99), "conflict");
  assert.equal(decideDualNoul(.95, .01), "supported");
  assert.equal(decideDualNoul(.01, .95), "contradicted");
  assert.equal(decideDualNoul(.8, .1), "unknown");
  assert.throws(() => decideDualNoul(NaN, .5));
});
