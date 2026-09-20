import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TYPE_SAFE_MODEL,
  buildTypeSafeRequest,
  parseTypeSafeResponse,
  verifyTypeSafeFacts,
} from "../src/lib/typesafe";
import type { ExtractedFact } from "../src/lib/memory";
import { runTypeSafePilotSafely } from "../src/lib/typesafe-pilot";
import { maskTypeSafeKey, resolveTypeSafeKey } from "../src/lib/typesafe-settings";
import { scoreTypeSafeEvaluations } from "../src/lib/typesafe-eval";

const fact = (index: number): ExtractedFact => ({
  type: "world",
  entityKey: `world:${index}`,
  title: `Факт ${index}`,
  content: `Подтверждённый факт номер ${index} о состоянии игрового мира.`,
  evidence: `Свидетельство ${index}`,
  importance: 70,
  confidence: 0.8,
});

test("TypeSafe request batches at most six facts and marks player action as intent", () => {
  const request = buildTypeSafeRequest({
    facts: Array.from({ length: 8 }, (_, index) => fact(index)),
    narration: "Рассказчик подтвердил последствия.",
    playerAction: "Я хочу открыть дверь.",
  });
  assert.equal(request.model, "jev-1.13.0");
  assert.equal(Object.keys(request.questions).length, 6);
  assert.deepEqual(Object.keys(request.questions), ["fact0", "fact1", "fact2", "fact3", "fact4", "fact5"]);
  assert.deepEqual(request.questions.fact0.criteria, {
    supports: "Повествование прямо подтверждает факт или однозначно из него следует.",
    contradicts: "Повествование прямо опровергает факт или сообщает несовместимое событие.",
    unsupported: "Доказательств недостаточно: это намерение, гипотеза, двусмысленность или отсутствующая информация.",
  });
  assert.deepEqual(request.state, {
    narrator_text: "Рассказчик подтвердил последствия.",
    player_action: { text: "Я хочу открыть дверь.", role: "Намерение игрока; не считать доказательством совершившегося события." },
    extracted_facts: Array.from({ length: 6 }, (_, index) => ({
      id: `fact${index}`,
      fact: fact(index).content,
      evidence: fact(index).evidence,
    })),
  });
});

test("TypeSafe response validator requires every bounded choice answer", () => {
  const result = parseTypeSafeResponse({
    model: TYPE_SAFE_MODEL,
    answers: {
      fact0: { type: "choice", choice: "supports", probabilities: { supports: 0.8, contradicts: 0.1, unsupported: 0.1 }, confidence: 0.7 },
      fact1: { type: "choice", choice: "unsupported", probabilities: { supports: 0.2, contradicts: 0, unsupported: 0.8 }, confidence: 1 },
    },
    usage: { input_tokens: 123, output_tokens: 25 },
  }, [fact(0), fact(1)]);
  assert.deepEqual(result, {
    model: TYPE_SAFE_MODEL,
    evaluations: [
      { factIndex: 0, fact: fact(0).content, evidence: fact(0).evidence, choice: "supports", probabilities: { supports: 0.8, contradicts: 0.1, unsupported: 0.1 }, confidence: 0.7 },
      { factIndex: 1, fact: fact(1).content, evidence: fact(1).evidence, choice: "unsupported", probabilities: { supports: 0.2, contradicts: 0, unsupported: 0.8 }, confidence: 1 },
    ],
    usage: { inputTokens: 123, outputTokens: 25 },
  });
  for (const invalid of [
    { answers: {}, usage: { input_tokens: 1, output_tokens: 1 }, model: TYPE_SAFE_MODEL },
    { answers: { fact0: { type: "choice", choice: "maybe", probabilities: { supports: 1, contradicts: 0, unsupported: 0 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 }, model: TYPE_SAFE_MODEL },
    { answers: { fact0: { type: "choice", choice: "supports", probabilities: { supports: Infinity, contradicts: 0, unsupported: 0 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 }, model: TYPE_SAFE_MODEL },
    { answers: { fact0: { type: "choice", choice: "supports", probabilities: { supports: 1.1, contradicts: 0, unsupported: 0 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 }, model: TYPE_SAFE_MODEL },
    { answers: { fact0: { type: "choice", choice: "supports", probabilities: { supports: 1, contradicts: 0, unsupported: 0 }, confidence: -0.1 } }, usage: { input_tokens: 1, output_tokens: 1 }, model: TYPE_SAFE_MODEL },
  ]) assert.throws(() => parseTypeSafeResponse(invalid, [fact(0)]), /Некорректный ответ TypeSafe/);
});

test("disabled, missing-key and empty paths make zero provider calls", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({}); };
  const base = { facts: [fact(0)], narration: "Текст", playerAction: "Действие", fetchImpl };
  assert.equal((await verifyTypeSafeFacts({ ...base, enabled: false, apiKey: "secret" })).status, "disabled");
  assert.equal((await verifyTypeSafeFacts({ ...base, enabled: true, apiKey: "" })).status, "no_key");
  assert.equal((await verifyTypeSafeFacts({ ...base, facts: [], enabled: true, apiKey: "secret" })).status, "empty");
  assert.equal(calls, 0);
});

test("provider call uses bearer auth, has no retries, and validates the complete response", async () => {
  let calls = 0;
  const report = await verifyTypeSafeFacts({
    enabled: true,
    apiKey: "top-secret-key",
    facts: [fact(0)],
    narration: "Свидетельство 0",
    playerAction: "Проверить",
    fetchImpl: async (input, init) => {
      calls++;
      assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer top-secret-key");
      return Response.json({ model: TYPE_SAFE_MODEL, answers: { fact0: { type: "choice", choice: "supports", probabilities: { supports: .9, contradicts: .05, unsupported: .05 }, confidence: .9 } }, usage: { input_tokens: 50, output_tokens: 10 } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.status, "ok");
  assert.equal(report.usage?.inputTokens, 50);
  assert.equal(report.evaluations.length, 1);
  assert.ok(report.latencyMs >= 0);
});

test("five-second timeout covers response body reading and still makes one attempt", async () => {
  let calls = 0;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    return { ok: true, status: 200, json: () => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })) } as Response;
  };
  const report = await verifyTypeSafeFacts({ enabled: true, apiKey: "secret", facts: [fact(0)], narration: "Текст", playerAction: "Действие", fetchImpl, timeoutMs: 15 });
  assert.equal(calls, 1);
  assert.equal(report.status, "error");
  assert.equal(report.error, "TypeSafe не ответил за 5 секунд.");
});

test("pilot config lookup and provider errors become diagnostics instead of worker failures", async () => {
  let verifyCalls = 0;
  const configFailure = await runTypeSafePilotSafely({
    facts: [fact(0)], narration: "Текст", playerAction: "Действие",
    loadConfig: async () => { throw new Error("database secret"); },
    verify: async () => { verifyCalls++; throw new Error("must not run"); },
  });
  assert.equal(configFailure.status, "error");
  assert.equal(configFailure.error, "Не удалось прочитать настройки TypeSafe.");
  assert.equal(verifyCalls, 0);

  const providerFailure = await runTypeSafePilotSafely({
    facts: [fact(0)], narration: "Текст", playerAction: "Действие",
    loadConfig: async () => ({ enabled: true, apiKey: "secret", source: "stored" }),
    verify: async () => { verifyCalls++; throw new Error("remote secret body"); },
  });
  assert.equal(providerFailure.status, "error");
  assert.equal(providerFailure.error, "Не удалось проверить факты через TypeSafe.");
  assert.equal(verifyCalls, 1);
});

test("disabled pilot returns diagnostics without invoking the verifier", async () => {
  let verifyCalls = 0;
  const report = await runTypeSafePilotSafely({
    facts: [fact(0)], narration: "Текст", playerAction: "Действие",
    loadConfig: async () => ({ enabled: false, apiKey: "secret", source: "stored" }),
    verify: async () => { verifyCalls++; throw new Error("must not run"); },
  });
  assert.equal(report.status, "disabled");
  assert.equal(verifyCalls, 0);
});

test("enabled pilot without a key returns diagnostics without invoking the verifier", async () => {
  let verifyCalls = 0;
  const report = await runTypeSafePilotSafely({
    facts: [fact(0)], narration: "Текст", playerAction: "Действие",
    loadConfig: async () => ({ enabled: true, apiKey: "", source: "none" }),
    verify: async () => { verifyCalls++; throw new Error("must not run"); },
  });
  assert.equal(report.status, "no_key");
  assert.equal(verifyCalls, 0);
});

test("environment key has priority and settings views expose only masks", () => {
  assert.deepEqual(resolveTypeSafeKey("stored-secret-1234", "env-secret-5678"), { apiKey: "env-secret-5678", source: "env" });
  assert.deepEqual(resolveTypeSafeKey("stored-secret-1234", "  "), { apiKey: "stored-secret-1234", source: "stored" });
  assert.deepEqual(resolveTypeSafeKey("", undefined), { apiKey: "", source: "none" });
  assert.equal(maskTypeSafeKey("stored-secret-1234"), "••••1234");
  assert.equal(maskTypeSafeKey("short"), "••••");
});

test("real-provider evaluation corpus has 60 balanced labelled Russian examples", () => {
  const scenarios = JSON.parse(readFileSync(new URL("./fixtures/typesafe-scenarios.json", import.meta.url), "utf8")) as { id: string; narration: string; playerAction: string; fact: string; evidence: string; expected: string; category: string }[];
  assert.equal(scenarios.length, 60);
  for (const expected of ["supports", "contradicts", "unsupported"]) assert.equal(scenarios.filter((item) => item.expected === expected).length, 20);
  for (const category of ["negation", "intention", "hypothesis", "ambiguity"]) assert.ok(scenarios.some((item) => item.category === category));
  for (const item of scenarios) {
    assert.match(item.id, /^[a-z]+-\d{2}$/);
    assert.ok(item.narration.length >= 20);
    assert.ok(item.fact.length >= 12);
    assert.ok(item.evidence.length >= 8);
  }
});

test("evaluation scorer reports confusion, errors, latency and token totals", () => {
  const score = scoreTypeSafeEvaluations([
    { expected: "supports", actual: "supports", latencyMs: 10, inputTokens: 20, outputTokens: 3 },
    { expected: "supports", actual: "unsupported", latencyMs: 30, inputTokens: 22, outputTokens: 4 },
    { expected: "contradicts", actual: null, latencyMs: 50, inputTokens: 0, outputTokens: 0 },
  ]);
  assert.equal(score.total, 3);
  assert.equal(score.correct, 1);
  assert.equal(score.errors, 1);
  assert.equal(score.accuracy, 0.5);
  assert.equal(score.averageLatencyMs, 30);
  assert.deepEqual(score.tokens, { input: 42, output: 7, total: 49 });
  assert.equal(score.confusion.supports.supports, 1);
  assert.equal(score.confusion.supports.unsupported, 1);
});
