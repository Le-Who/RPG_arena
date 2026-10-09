import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function cli(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--import", "./tests/helpers/test-environment.ts", "scripts/eval-story-drafts.ts", ...args], { cwd: process.cwd(), env: { ...process.env, STORY_EVAL_COOKIE: "", ...env }, windowsHide: true });
    let output = ""; const timer = setTimeout(() => { child.kill(); reject(new Error("CLI_TEST_TIMEOUT")); }, 10_000);
    child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
    child.on("error", error => { clearTimeout(timer); reject(error); }); child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
async function httpFixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  let calls = 0;
  const server = createServer((request, response) => { calls++; handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, calls: () => calls, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

test("story evaluation current tsx/CJS entrypoint runs dry before any network without --live", async () => {
  const fixture = await httpFixture((_request, response) => response.end("unwanted request"));
  try {
    const result = await cli([`--base-url=${fixture.url}`]);
    assert.equal(result.code, 0, result.output); assert.match(result.output, /DRY RUN/); assert.equal(fixture.calls(), 0);
  } finally { await fixture.close(); }
});

test("story evaluation requires explicit identity cookie before authorized network", async () => {
  const fixture = await httpFixture((_request, response) => response.end("unwanted request"));
  try {
    const result = await cli(["--live", `--base-url=${fixture.url}`]);
    assert.equal(result.code, 1); assert.match(result.output, /STORY_EVAL_COOKIE|--cookie/); assert.equal(fixture.calls(), 0);
  } finally { await fixture.close(); }
});

test("story evaluation accepts selected external narrator and sends cookie without logging it", async () => {
  const cookie = "chronicle_account_session=SYNTHETIC_COOKIE_SENTINEL";
  let validIdentity = 0;
  const fixture = await httpFixture((request, response) => {
    if (request.headers.cookie === cookie) validIdentity++;
    let body = "";
    request.on("data", bytes => { body += bytes; }); request.on("end", () => {
      const { draft } = JSON.parse(body) as { draft: Record<string, string> };
      const patch = Object.fromEntries(Object.entries(draft).filter(([field, value]) => field !== "rulesProfile" && !value.trim()).map(([field]) => [field, field === "pitch" ? "Герой помогает соседям организовать встречу во дворе." : "Доброе утро"]));
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ patch, modelUsed: "openrouter/selected-narrator" }));
    });
  });
  const directory = await mkdtemp(join(tmpdir(), "chronicle-story-eval-"));
  try {
    const out = join(directory, "report.json");
    const result = await cli(["--live", `--base-url=${fixture.url}`, `--out=${out}`], { STORY_EVAL_COOKIE: cookie });
    assert.equal(result.code, 0, result.output); assert.equal(fixture.calls(), 24); assert.equal(validIdentity, 24);
    const raw = await readFile(out, "utf8"); const report = JSON.parse(raw);
    assert.equal(report.passed, 24); assert.equal(report.total, 24); assert.equal(report.coherenceReview, "pending-human-review");
    assert.ok(report.results.every((item: { modelUsed: string }) => item.modelUsed === "openrouter/selected-narrator"));
    assert.doesNotMatch(result.output + raw, /SYNTHETIC_COOKIE_SENTINEL/);
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test("story evaluation preflights explicit request budget before network", async () => {
  const fixture = await httpFixture((_request, response) => response.end("unwanted request"));
  try {
    const result = await cli(["--live", `--base-url=${fixture.url}`, "--max-calls=1"], { STORY_EVAL_COOKIE: "session=fixture" });
    assert.equal(result.code, 1); assert.match(result.output, /STORY_EVAL_CALL_BUDGET/); assert.equal(fixture.calls(), 0);
  } finally { await fixture.close(); }
});

test("story evaluation response errors use safe codes, excluding body secrets from logs and report", async () => {
  const fixture = await httpFixture((_request, response) => { response.writeHead(502, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "SYNTHETIC_PROVIDER_KEY_SENTINEL", message: "SYNTHETIC_PROVIDER_BODY_SENTINEL" })); });
  const directory = await mkdtemp(join(tmpdir(), "chronicle-story-eval-"));
  try {
    const out = join(directory, "report.json");
    const result = await cli(["--live", `--base-url=${fixture.url}`, `--out=${out}`], { STORY_EVAL_COOKIE: "session=fixture" });
    assert.equal(result.code, 1); const raw = await readFile(out, "utf8");
    assert.match(result.output, /STORY_EVAL_HTTP_502/); assert.doesNotMatch(result.output + raw, /SYNTHETIC_PROVIDER/);
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

type CliReport = {
  total: number;
  passed: number;
  failed: number;
  coherenceReview: string;
  results: { passed: boolean; error?: string; issues: string[]; modelUsed?: string; latencyMs: number }[];
};

function assertFailedReport(report: CliReport, error: string) {
  assert.equal(report.total, 24);
  assert.equal(report.passed, 0);
  assert.equal(report.failed, 24);
  assert.equal(report.coherenceReview, "pending-human-review");
  assert.equal(report.results.length, 24);
  for (const item of report.results) {
    assert.equal(item.passed, false);
    assert.equal(item.error, error);
    assert.deepEqual(item.issues, [error]);
    assert.equal(item.modelUsed, undefined);
  }
}

// Hand-authored structural responses in the fixture file's order. They are not
// generated with the production patch validator; coherence still needs a person.
const selectedModelPatches = [
  { title: "Утро", worldName: "Двор", pitch: "Герой помогает соседям организовать встречу во дворе.", era: "Сегодня", tone: "Спокойный", mainQuest: "Помочь соседям", startLocation: "Двор", name: "Саша", archetype: "Сосед", backstory: "Живёт рядом", skills: "Разговор", startItems: "Блокнот" },
  { pitch: "В архиве обнаружено письмо, адресованное незнакомому человеку.", mainQuest: "Найти адресата", startLocation: "Архив", name: "Анна", archetype: "Исследователь", backstory: "Изучает письма", skills: "Чтение", startItems: "Блокнот" },
  { title: "Поиск", pitch: "Спасатели получают координаты корабля, который перестал отвечать.", startLocation: "Станция", name: "Ира", archetype: "Спасатель", backstory: "Работает в команде", startItems: "Рация" },
  { title: "Рецепт", mainQuest: "Вернуть рецепт", name: "Нина", archetype: "Пекарь", backstory: "Готовит к ярмарке", skills: "Выпечка", startItems: "Корзина" },
  { pitch: "Врач получает просьбу помочь семье за пределами нового форта.", mainQuest: "Помочь семье", backstory: "Лечит жителей", startItems: "Перевязки" },
  { title: "Посылка", name: "Ян", backstory: "Знает район" },
  { pitch: "Ася находит записку о последнем фонаре в заснеженной долине.", startLocation: "Мастерская", backstory: "Помогает фонарщику", skills: "Ремонт фонарей" },
  { title: "Колодец", mainQuest: "Найти воду", name: "Олег", backstory: "Ведёт караван" },
  { pitch: "Гидроакустик замечает повторяющийся сигнал из закрытой лаборатории.", name: "Лена", backstory: "Изучает город" },
  { title: "Фотография", mainQuest: "Найти человека" },
  { title: "Словарь", pitch: "В библиотеке остался след чернил, ведущий к пропавшему слову.", name: "Миша", backstory: "Учится переплёту" },
  { name: "Оля", archetype: "Пассажир", backstory: "Едет домой", skills: "Наблюдение", startItems: "Билет" },
  { backstory: "Работает на станции" },
  { title: "Источник", mainQuest: "Сохранить источник", name: "Павел", backstory: "Разбирает споры" },
  { name: "Мария", backstory: "Изучает берег" },
  { name: "Лев", backstory: "Работает ночью" },
  { title: "Печать", backstory: "Готовит договор" },
  { pitch: "На спорной карте появляются новые отметки движущегося острова.", name: "Роман" },
  { title: "Сад", mainQuest: "Исследовать растения", name: "Варя", backstory: "Изучает болезни растений" },
  { name: "Игорь", backstory: "Участвует в экспедиции" },
  { title: "Письмо", name: "Юля", backstory: "Восстанавливает письма", skills: "Чтение почерка" },
  { startItems: "Рация" },
  { title: "Берег", name: "Даша", backstory: "Помогает пассажирам" },
  { name: "Соня", backstory: "Помнит дорогу к музею" },
];

test("story evaluation deadline aborts an unfinished body after headers and partial JSON arrive", async () => {
  const cookie = "session=SYNTHETIC_BODY_TIMEOUT_COOKIE_SENTINEL";
  let headersFlushed = 0;
  let partialBodiesWritten = 0;
  let validIdentity = 0;
  let closedBodies = 0;
  const fixture = await httpFixture((request, response) => {
    if (request.headers.cookie === cookie) validIdentity++;
    request.resume();
    response.on("close", () => { closedBodies++; });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders(); headersFlushed++;
    response.write('{"patch":{"title":"SYNTHETIC_UNFINISHED_BODY_SENTINEL', () => { partialBodiesWritten++; });
    // Intentionally leave the body open until the CLI aborts its own request.
  });
  const directory = await mkdtemp(join(tmpdir(), "chronicle-story-eval-"));
  try {
    const out = join(directory, "report.json");
    const started = performance.now();
    const result = await cli(["--live", `--base-url=${fixture.url}`, "--timeout-ms=200", `--out=${out}`], { STORY_EVAL_COOKIE: cookie });
    const elapsedMs = performance.now() - started;
    assert.equal(result.code, 1);
    assert.ok(elapsedMs < 8000, `unfinished-body CLI took ${elapsedMs} ms; bound is 8000 ms`);
    assert.equal(fixture.calls(), 24);
    assert.equal(validIdentity, 24);
    assert.equal(headersFlushed, 24);
    assert.equal(partialBodiesWritten, 24);
    assert.equal(closedBodies, 24);
    const raw = await readFile(out, "utf8"); const report: CliReport = JSON.parse(raw);
    assertFailedReport(report, "STORY_EVAL_TIMEOUT");
    for (const item of report.results) assert.ok(item.latencyMs < 2000, `body timeout took ${item.latencyMs} ms; bound is 2000 ms`);
    assert.match(result.output, /STORY_EVAL_TIMEOUT/);
    assert.doesNotMatch(result.output + raw, /SYNTHETIC_BODY_TIMEOUT_COOKIE_SENTINEL|SYNTHETIC_UNFINISHED_BODY_SENTINEL/);
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test("story evaluation deadline aborts a request that never receives response headers", async () => {
  let closedRequests = 0;
  const fixture = await httpFixture((request, response) => {
    request.resume();
    response.on("close", () => { closedRequests++; });
    // No headers or body: this fails while awaiting fetch, before body parsing.
  });
  const directory = await mkdtemp(join(tmpdir(), "chronicle-story-eval-"));
  try {
    const out = join(directory, "report.json");
    const started = performance.now();
    const result = await cli(["--live", `--base-url=${fixture.url}`, "--timeout-ms=200", `--out=${out}`], { STORY_EVAL_COOKIE: "session=SYNTHETIC_HEADER_TIMEOUT_COOKIE_SENTINEL" });
    assert.equal(result.code, 1);
    assert.ok(performance.now() - started < 8000, "pre-header CLI exceeded the literal 8000 ms bound");
    assert.equal(fixture.calls(), 24);
    assert.equal(closedRequests, 24);
    const raw = await readFile(out, "utf8"); const report: CliReport = JSON.parse(raw);
    assertFailedReport(report, "STORY_EVAL_TIMEOUT");
    assert.doesNotMatch(result.output + raw, /SYNTHETIC_HEADER_TIMEOUT_COOKIE_SENTINEL/);
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test("story evaluation refuses 302 redirects without sending requests or identity to their target", async () => {
  const cookie = "session=SYNTHETIC_REDIRECT_COOKIE_SENTINEL";
  let targetCookies = 0;
  const target = await httpFixture((request, response) => {
    if (request.headers.cookie) targetCookies++;
    response.end('{"patch":{},"modelUsed":"openrouter/redirect-target"}');
  });
  let sourceIdentity = 0;
  const source = await httpFixture((request, response) => {
    if (request.headers.cookie === cookie) sourceIdentity++;
    request.resume();
    response.writeHead(302, { Location: `${target.url}/SYNTHETIC_REDIRECT_LOCATION_SENTINEL` });
    response.end("SYNTHETIC_REDIRECT_BODY_SENTINEL");
  });
  const directory = await mkdtemp(join(tmpdir(), "chronicle-story-eval-"));
  try {
    const out = join(directory, "report.json");
    const result = await cli(["--live", `--base-url=${source.url}`, `--out=${out}`], { STORY_EVAL_COOKIE: cookie });
    assert.equal(result.code, 1);
    assert.equal(source.calls(), 24); assert.equal(sourceIdentity, 24);
    assert.equal(target.calls(), 0); assert.equal(targetCookies, 0);
    const raw = await readFile(out, "utf8"); const report: CliReport = JSON.parse(raw);
    assertFailedReport(report, "STORY_EVAL_REQUEST_FAILED");
    assert.doesNotMatch(result.output + raw, /SYNTHETIC_REDIRECT_(?:COOKIE|LOCATION|BODY)_SENTINEL/);
  } finally { await source.close(); await target.close(); await rm(directory, { recursive: true, force: true }); }
});

test("story evaluation accepts an exact --expected-model match for the selected external narrator", async () => {
  let responseIndex = 0;
  let validRequests = 0;
  const cookie = "session=SYNTHETIC_EXACT_MODEL_COOKIE_SENTINEL";
  const fixture = await httpFixture((request, response) => {
    if (request.method === "POST" && request.url === "/api/story-drafts/autofill" && request.headers.cookie === cookie && request.headers["content-type"] === "application/json") validRequests++;
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ patch: selectedModelPatches[responseIndex++], modelUsed: "openrouter/selected-narrator" }));
  });
  const directory = await mkdtemp(join(tmpdir(), "chronicle-story-eval-"));
  try {
    const out = join(directory, "report.json");
    const result = await cli(["--live", `--base-url=${fixture.url}`, "--expected-model=openrouter/selected-narrator", `--out=${out}`], { STORY_EVAL_COOKIE: cookie });
    assert.equal(result.code, 0, result.output);
    assert.equal(fixture.calls(), 24); assert.equal(validRequests, 24); assert.equal(responseIndex, 24);
    const raw = await readFile(out, "utf8"); const report: CliReport = JSON.parse(raw);
    assert.equal(report.total, 24); assert.equal(report.passed, 24); assert.equal(report.failed, 0);
    assert.equal(report.coherenceReview, "pending-human-review"); assert.equal(report.results.length, 24);
    for (const item of report.results) { assert.equal(item.passed, true); assert.deepEqual(item.issues, []); assert.equal(item.modelUsed, "openrouter/selected-narrator"); }
    assert.doesNotMatch(result.output + raw, /SYNTHETIC_EXACT_MODEL_COOKIE_SENTINEL/);
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test("story evaluation safely rejects a near-match --expected-model without reporting provider text", async () => {
  let responseIndex = 0;
  const fixture = await httpFixture((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ patch: selectedModelPatches[responseIndex++], modelUsed: "openrouter/selected-narrator-SYNTHETIC_MODEL_BODY_SENTINEL" }));
  });
  const directory = await mkdtemp(join(tmpdir(), "chronicle-story-eval-"));
  try {
    const out = join(directory, "report.json");
    const result = await cli(["--live", `--base-url=${fixture.url}`, "--expected-model=openrouter/selected-narrator", `--out=${out}`], { STORY_EVAL_COOKIE: "session=SYNTHETIC_MISMATCH_COOKIE_SENTINEL" });
    assert.equal(result.code, 1); assert.equal(fixture.calls(), 24); assert.equal(responseIndex, 24);
    const raw = await readFile(out, "utf8"); const report: CliReport = JSON.parse(raw);
    assertFailedReport(report, "STORY_EVAL_UNEXPECTED_MODEL");
    assert.match(result.output, /STORY_EVAL_UNEXPECTED_MODEL/);
    assert.doesNotMatch(result.output + raw, /SYNTHETIC_MODEL_BODY_SENTINEL|SYNTHETIC_MISMATCH_COOKIE_SENTINEL/);
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const body of [
  { name: "malformed JSON", text: "SYNTHETIC_MALFORMED_BODY_SENTINEL", error: "STORY_EVAL_REQUEST_FAILED" },
  { name: "truncated JSON", text: '{"patch":{"title":"SYNTHETIC_TRUNCATED_BODY_SENTINEL"', error: "STORY_EVAL_REQUEST_FAILED" },
  { name: "invalid patch shape", text: '{"patch":["SYNTHETIC_INVALID_PATCH_SENTINEL"],"modelUsed":"openrouter/selected-narrator"}', error: "STORY_EVAL_INVALID_RESPONSE" },
]) {
  test(`story evaluation safely rejects ${body.name} after the response body ends`, async () => {
    const fixture = await httpFixture((request, response) => {
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(body.text);
    });
    const directory = await mkdtemp(join(tmpdir(), "chronicle-story-eval-"));
    try {
      const out = join(directory, "report.json");
      const result = await cli(["--live", `--base-url=${fixture.url}`, `--out=${out}`], { STORY_EVAL_COOKIE: "session=SYNTHETIC_MALFORMED_COOKIE_SENTINEL" });
      assert.equal(result.code, 1); assert.equal(fixture.calls(), 24);
      const raw = await readFile(out, "utf8"); const report: CliReport = JSON.parse(raw);
      assertFailedReport(report, body.error);
      assert.doesNotMatch(result.output + raw, /SYNTHETIC_/);
    } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
