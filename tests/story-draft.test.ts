import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STORY_TEXT_FIELDS,
  StoryDraftError,
  canApplyStoryDraftPatch,
  createStoryDraftAutofillService,
  evaluateStoryDraftPatch,
  filterStoryDraftPatch,
  validateStoryDraft,
  storyDraftCreationError,
  type StoryDraft,
  type StoryDraftGenerationCall,
} from "../src/lib/story-draft";
import { routeModelsFor } from "../src/lib/gemini";
import { callGeminiWithRotation } from "../src/lib/gemini";
import { QuotaAdmissionError } from "../src/lib/quota-errors";
import { handleStoryDraftAutofillRequest } from "../src/lib/story-draft-route";

test("route deadline includes stalled config/log work and propagates cancellation", async () => {
  let signal: AbortSignal | undefined;
  const response = await handleStoryDraftAutofillRequest(new Request("http://local/api/story-drafts/autofill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: {} }) }), async (_, incoming) => {
    signal = incoming;
    return new Promise(() => {});
  }, 20);
  assert.equal(response.status, 504);
  assert.equal(signal?.aborted, true);
});

test("autofill rejects a short supplied pitch without rewriting it", () => {
  assert.throws(() => validateStoryDraft(blankDraft({ pitch: "коротко" })), /15/);
});

test("creation highlights invalid authored lists and whitespace instead of truncating", () => {
  assert.match(storyDraftCreationError("skills", "а,б,в,г,д,е,ж"), /6/);
  assert.match(storyDraftCreationError("startItems", "x".repeat(61)), /60/);
  assert.ok(storyDraftCreationError("title", "  "));
  assert.ok(storyDraftCreationError("pitch", "коротко"));
  assert.equal(storyDraftCreationError("skills", "Анализ, Переговоры"), "");
  assert.equal(storyDraftCreationError("archetype", ""), "");
});

const blankDraft = (overrides: Partial<StoryDraft> = {}): StoryDraft => ({
  title: "",
  worldName: "",
  pitch: "",
  era: "",
  tone: "",
  mainQuest: "",
  startLocation: "",
  name: "",
  archetype: "",
  backstory: "",
  skills: "",
  startItems: "",
  rulesProfile: "narrative",
  ...overrides,
});

const completeGeneratedDraft = {
  title: "Пепельный маяк",
  worldName: "Архипелаг Семи Штормов",
  pitch: "Маяк погас, и острова начали исчезать из памяти мореходов.",
  era: "век парусных машин",
  tone: "тревожное приключение",
  mainQuest: "Зажечь маяк до прихода чёрного прилива",
  startLocation: "порт Латунной бухты",
  name: "Ида Рейн",
  archetype: "штурман-изгнанница",
  backstory: "Ида однажды провела корабль сквозь запретный шторм и потеряла команду.",
  skills: ["навигация", "чтение погоды"],
  startItems: ["медный секстант", "карта без северного края"],
};

test("draft validation rejects oversized user input instead of truncating it", () => {
  assert.throws(
    () => validateStoryDraft(blankDraft({ title: "я".repeat(81) })),
    (error: unknown) => error instanceof StoryDraftError && error.code === "INVALID_INPUT",
  );
  assert.throws(() => validateStoryDraft(blankDraft({ skills: "а".repeat(41) })), /Навыки/);
  assert.throws(() => validateStoryDraft(blankDraft({ startItems: "a, b, c, d, e, f, g" })), /не больше 6/);
});

test("patch filtering preserves every non-empty user value and excludes rulesProfile", () => {
  const draft = blankDraft({
    title: "  Мой заголовок  ",
    tone: "авторский тон",
    skills: "следопытство, старая школа",
    rulesProfile: "d20",
  });
  const patch = filterStoryDraftPatch(draft, {
    ...completeGeneratedDraft,
    title: "Чужой заголовок",
    tone: "чужой тон",
    skills: ["чужой навык"],
    rulesProfile: "rules-light",
  });

  assert.equal(draft.title, "  Мой заголовок  ");
  assert.equal(draft.tone, "авторский тон");
  assert.equal(draft.skills, "следопытство, старая школа");
  assert.equal(draft.rulesProfile, "d20");
  assert.equal("title" in patch, false);
  assert.equal("tone" in patch, false);
  assert.equal("skills" in patch, false);
  assert.equal("rulesProfile" in patch, false);
  assert.equal(patch.name, "Ида Рейн");
});

test("patch filtering preserves each populated story text field", () => {
  for (const field of STORY_TEXT_FIELDS) {
    const authored = field === "pitch" ? "Авторская завязка длиннее пятнадцати символов" : `авторское значение ${field}`;
    const draft = blankDraft({ [field]: authored });
    const patch = filterStoryDraftPatch(draft, completeGeneratedDraft);
    assert.equal(draft[field], authored, field);
    assert.equal(field in patch, false, field);
  }
});

test("whitespace-only draft fields are fillable while whitespace-only generated values are invalid", () => {
  const patch = filterStoryDraftPatch(blankDraft({ title: "   ", tone: "  мой тон  " }), completeGeneratedDraft);
  assert.equal(patch.title, completeGeneratedDraft.title);
  assert.equal("tone" in patch, false);
  assert.throws(() => filterStoryDraftPatch(blankDraft(), { ...completeGeneratedDraft, name: "   " }), /непустая строка/);
  assert.throws(() => filterStoryDraftPatch(blankDraft(), { ...completeGeneratedDraft, skills: ["   "] }), /Навыки/);
});

test("autofill skips the provider when every text field is populated", async () => {
  let providerCalls = 0;
  const service = createStoryDraftAutofillService({
    loadConfig: async () => ({ keys: ["secret"], canUseLive: true }),
    selectModels: async () => ["gemini-3.5-flash-lite"],
    generate: async () => { providerCalls += 1; throw new Error("must not run"); },
    log: async () => {},
  });
  const full = blankDraft({
    ...Object.fromEntries(Object.keys(completeGeneratedDraft).map((key) => [key, "заполнено"])),
    pitch: "Достаточно подробная завязка истории.",
    skills: "наблюдение",
    startItems: "фонарь",
  });

  assert.deepEqual(await service(full), { patch: {}, modelUsed: "none" });
  assert.equal(providerCalls, 0);
});

test("autofill uses only Lite, fills missing fields and logs creation without a session", async () => {
  const calls: StoryDraftGenerationCall[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const service = createStoryDraftAutofillService({
    loadConfig: async () => ({ keys: ["secret"], canUseLive: true }),
    selectModels: async () => ["gemini-3.5-flash-lite"],
    generate: async (call) => {
      calls.push(call);
      return { text: JSON.stringify(completeGeneratedDraft), model: "gemini-3.5-flash-lite", keyIndex: 0, latencyMs: 37, promptTokens: 101, completionTokens: 55 };
    },
    log: async (row) => { logs.push(row); },
  });

  const result = await service(blankDraft({ title: "Моя история" }));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].models, ["gemini-3.5-flash-lite"]);
  assert.ok(calls[0].timeoutMs > 0 && calls[0].timeoutMs <= 30_000);
  assert.equal(result.patch.title, undefined);
  assert.equal(result.patch.worldName, completeGeneratedDraft.worldName);
  assert.equal(result.patch.skills, "навигация, чтение погоды");
  assert.equal(result.modelUsed, "gemini-3.5-flash-lite");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].taskType, "creation");
  assert.equal(logs[0].sessionId, null);
});

test("autofill repairs malformed output once inside the shared 30 second deadline", async () => {
  const calls: StoryDraftGenerationCall[] = [];
  const times = [1_000, 1_000, 12_000, 12_000];
  const service = createStoryDraftAutofillService({
    loadConfig: async () => ({ keys: ["secret"], canUseLive: true }),
    selectModels: async () => ["gemini-3.5-flash-lite"],
    generate: async (call) => {
      calls.push(call);
      if (calls.length === 1) return { text: "{bad json", model: "gemini-3.5-flash-lite", keyIndex: 0, latencyMs: 11_000, promptTokens: 50, completionTokens: 5 };
      return { text: JSON.stringify(completeGeneratedDraft), model: "gemini-3.5-flash-lite", keyIndex: 0, latencyMs: 500, promptTokens: 60, completionTokens: 45 };
    },
    log: async () => {},
    now: () => times.shift() ?? 12_000,
  });

  const result = await service(blankDraft());

  assert.equal(calls.length, 2);
  assert.equal(calls[1].timeoutMs, 19_000);
  assert.match(calls[1].system, /исправ/i);
  assert.equal(result.patch.title, completeGeneratedDraft.title);
});

test("autofill never makes a second repair attempt", async () => {
  let calls = 0;
  const service = createStoryDraftAutofillService({
    loadConfig: async () => ({ keys: ["secret"], canUseLive: true }),
    selectModels: async () => ["gemini-3.5-flash-lite"],
    generate: async () => {
      calls += 1;
      return { text: calls === 1 ? "not-json" : "still-not-json", model: "gemini-3.5-flash-lite", keyIndex: 0, latencyMs: 2, promptTokens: 1, completionTokens: 1 };
    },
    log: async () => {},
  });

  await assert.rejects(service(blankDraft()), (error: unknown) => error instanceof StoryDraftError && error.code === "AI_FAILED");
  assert.equal(calls, 2);
});

test("autofill rechecks Lite quota before spending the repair call", async () => {
  let providerCalls = 0;
  let quotaChecks = 0;
  const service = createStoryDraftAutofillService({
    loadConfig: async () => ({ keys: ["secret"], canUseLive: true }),
    selectModels: async () => (++quotaChecks === 1 ? ["gemini-3.5-flash-lite"] : []),
    generate: async () => {
      providerCalls += 1;
      return { text: "invalid", model: "gemini-3.5-flash-lite", keyIndex: 0, latencyMs: 2, promptTokens: 1, completionTokens: 1 };
    },
    log: async () => {},
  });

  await assert.rejects(service(blankDraft()), (error: unknown) => error instanceof StoryDraftError && error.status === 429);
  assert.equal(quotaChecks, 2);
  assert.equal(providerCalls, 1);
});

test("autofill HTTP preserves race-time admission errors after Lite prefilter passes", async t => {
  const oldFetch = global.fetch;
  let fetches = 0;
  try {
    global.fetch = async () => { fetches++; throw new Error("Unexpected provider fetch"); };
    for (const [admission, status, code] of [
      [new QuotaAdmissionError("QUOTA_EXHAUSTED"), 429, "QUOTA_EXHAUSTED"],
      [new QuotaAdmissionError("QUOTA_UNAVAILABLE"), 503, "QUOTA_UNAVAILABLE"],
      [new QuotaAdmissionError("QUOTA_ADMISSION_TIMEOUT"), 504, "QUOTA_ADMISSION_TIMEOUT"],
    ] as const) await t.test(code, async () => {
      const service = createStoryDraftAutofillService({
        loadConfig: async () => ({ keys: ["synthetic-secret"], canUseLive: true }),
        selectModels: async () => ["gemini-3.5-flash-lite"],
        generate: callGeminiWithRotation,
        beforeAttempt: async () => { throw admission; },
        log: async () => {},
      });
      const response = await handleStoryDraftAutofillRequest(new Request("https://game.test/api/story-drafts/autofill", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft: blankDraft() }),
      }), service);
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.code, code);
      assert.equal(body.message.includes("synthetic-secret"), false);
      assert.equal(fetches, 0);
    });
  } finally { global.fetch = oldFetch; }
});

test("provider failures do not expose remote response bodies", async () => {
  const service = createStoryDraftAutofillService({
    loadConfig: async () => ({ keys: ["secret"], canUseLive: true }),
    selectModels: async () => ["gemini-3.5-flash-lite"],
    generate: async () => { throw new Error("HTTP 500: upstream-secret-body"); },
    log: async () => {},
  });

  await assert.rejects(service(blankDraft()), (error: unknown) => error instanceof StoryDraftError && !error.message.includes("upstream-secret-body"));
});

test("autofill reports AI_REQUIRED before provider or quota work when live AI is unavailable", async () => {
  let work = 0;
  const service = createStoryDraftAutofillService({
    loadConfig: async () => ({ keys: [], canUseLive: false }),
    selectModels: async () => { work += 1; return []; },
    generate: async () => { work += 1; throw new Error("must not run"); },
    log: async () => {},
  });

  await assert.rejects(service(blankDraft()), (error: unknown) => error instanceof StoryDraftError && error.code === "AI_REQUIRED");
  assert.equal(work, 0);
});

test("generated lists must stay within item count, item length and form length limits", async () => {
  const invalid = { ...completeGeneratedDraft, skills: ["a", "b", "c", "d", "e", "f", "g"] };
  let calls = 0;
  const service = createStoryDraftAutofillService({
    loadConfig: async () => ({ keys: ["secret"], canUseLive: true }),
    selectModels: async () => ["gemini-3.5-flash-lite"],
    generate: async () => {
      calls += 1;
      return { text: JSON.stringify(invalid), model: "gemini-3.5-flash-lite", keyIndex: 0, latencyMs: 2, promptTokens: 1, completionTokens: 1 };
    },
    log: async () => {},
  });

  await assert.rejects(service(blankDraft()), /невалидный ответ/i);
  assert.equal(calls, 2);
});

test("generated list items cannot hide more than six comma-delimited values", () => {
  assert.throws(
    () => filterStoryDraftPatch(blankDraft(), { ...completeGeneratedDraft, skills: ["а,б,в,г,д,е,ж"] }),
    /не больше 6/,
  );
});

test("creation routing is always Lite-only regardless of the user's routing profile", () => {
  assert.deepEqual(routeModelsFor("creation", {
    profile: "flagship",
    fastTaskModel: "gemini-3.8-flash",
  }), ["gemini-3.5-flash-lite"]);
});

test("autofill HTTP handler accepts {draft} and exposes structured domain errors", async () => {
  const success = await handleStoryDraftAutofillRequest(
    new Request("https://example.test/api/story-drafts/autofill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: blankDraft() }),
    }),
    async () => ({ patch: { title: "Новая история" }, modelUsed: "gemini-3.5-flash-lite" }),
  );
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { patch: { title: "Новая история" }, modelUsed: "gemini-3.5-flash-lite" });

  const required = await handleStoryDraftAutofillRequest(
    new Request("https://example.test/api/story-drafts/autofill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: blankDraft() }),
    }),
    async () => { throw new StoryDraftError("AI_REQUIRED", "Добавьте ключ."); },
  );
  assert.equal(required.status, 409);
  assert.deepEqual(await required.json(), { ok: false, code: "AI_REQUIRED", message: "Добавьте ключ." });
});

test("client guard discards a whole patch after edits, mode changes or a newer request", () => {
  const requested = blankDraft();
  assert.equal(canApplyStoryDraftPatch({ requested, current: requested, requestedMode: "free", currentMode: "free", requestId: 4, currentRequestId: 4 }), true);
  assert.equal(canApplyStoryDraftPatch({ requested, current: blankDraft({ tone: "нуар" }), requestedMode: "free", currentMode: "free", requestId: 4, currentRequestId: 4 }), false);
  assert.equal(canApplyStoryDraftPatch({ requested, current: requested, requestedMode: "free", currentMode: "preset", requestId: 4, currentRequestId: 4 }), false);
  assert.equal(canApplyStoryDraftPatch({ requested, current: requested, requestedMode: "free", currentMode: "free", requestId: 4, currentRequestId: 5 }), false);
});

test("real-provider evaluation corpus contains 24 valid Russian draft scenarios", () => {
  const fixtures = JSON.parse(readFileSync("tests/fixtures/story-draft-scenarios.json", "utf8")) as Array<{ id: string; description: string; draft: StoryDraft }>;
  assert.equal(fixtures.length, 24);
  assert.equal(new Set(fixtures.map((fixture) => fixture.id)).size, 24);
  for (const fixture of fixtures) {
    assert.match(fixture.description, /[А-Яа-яЁё]/, fixture.id);
    assert.deepEqual(validateStoryDraft(fixture.draft), fixture.draft);
    assert.ok(Object.values(fixture.draft).some((value) => value === ""), `${fixture.id} should exercise generation`);
  }
});

test("evaluation scorer checks completeness, preservation and final server validity", () => {
  const draft = blankDraft({ title: "Авторский заголовок" });
  const good = filterStoryDraftPatch(draft, completeGeneratedDraft);
  assert.deepEqual(evaluateStoryDraftPatch(draft, good), { passed: true, issues: [] });
  assert.deepEqual(evaluateStoryDraftPatch(draft, { title: "Перезаписан", name: "" }), {
    passed: false,
    issues: ["перезаписано заполненное поле title", "не заполнено поле worldName", "не заполнено поле pitch", "не заполнено поле era", "не заполнено поле tone", "не заполнено поле mainQuest", "не заполнено поле startLocation", "не заполнено поле name", "не заполнено поле archetype", "не заполнено поле backstory", "не заполнено поле skills", "не заполнено поле startItems"],
  });
});
