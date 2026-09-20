import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvalCorpus, retrievalMetrics } from "../scripts/memory-eval-fixture";

test("evaluation has fixed labels, unique documents and nested corpus sizes", () => {
  const small = buildEvalCorpus(100), large = buildEvalCorpus(10000);
  assert.equal(large.memories.length, 10000);
  assert.equal(new Set(large.memories.map(n => n.content)).size, 10000);
  assert.deepEqual(large.memories.slice(0,100), small.memories);
  assert.deepEqual(large.questions, small.questions);
  assert.equal(large.questions.length, 24);
  assert.equal(new Set(large.questions.map(q => q.genre)).size, 4);
  assert.equal(new Set(small.questions.map(q => small.memories.find(m => m.id === q.relevant[0])?.layer)).size, 4);
  for (const q of small.questions) assert.ok(q.relevant.every(id => small.memories.some(m => m.id === id)));
});

test("recall and reciprocal rank do not count duplicate hits twice", () => {
  assert.deepEqual(retrievalMetrics(["wrong", "a", "a"], ["a", "b"]), { hit1: 0, recall8: .5, mrr8: .5 });
  assert.deepEqual(retrievalMetrics(["a"], ["a"]), { hit1: 1, recall8: 1, mrr8: 1 });
});
