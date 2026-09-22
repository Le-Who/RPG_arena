/** Run against a disposable offline server: SMOKE_BASE_URL=... DATABASE_URL=... node --import tsx scripts/user-isolation-smoke.ts */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
type Json = Record<string, any>; // API assertions intentionally inspect heterogeneous response payloads.
class Visitor {
  cookie = "";
  async call(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: process.env.CHRONICLE_PUBLIC_ORIGIN || new URL(base).origin, ...(this.cookie ? { Cookie: this.cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i, `personalized response must not be cached: ${path}`);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      this.cookie = setCookie.split(";")[0];
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
      assert.match(setCookie, /Path=\//i);
      assert.match(setCookie, /Max-Age=31536000/i);
      if (base.startsWith("https:")) assert.match(setCookie, /Secure/i);
    }
    const text = await response.text();
    let data: Json;
    try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: response.status, data, headers: response.headers };
  }
  async ok(path: string, body?: unknown, method?: string): Promise<Json> {
    const result = await this.call(path, body, method);
    assert.ok(result.status >= 200 && result.status < 300, `${method ?? "GET"} ${path}: ${result.status} ${JSON.stringify(result.data)}`);
    return result.data;
  }
}
const a = new Visitor(), b = new Visitor();
const campaigns: { visitor: Visitor; id: string }[] = [];
const seededLogs: string[] = [];
const profiles: string[] = [];
async function denied(visitor: Visitor, path: string, body?: unknown, method?: string) {
  assert.equal((await visitor.call(path, body, method)).status, 404, `other visitor must not access ${method ?? "GET"} ${path}`);
}
async function run() {
  const aw = await a.ok("/api/workspace"), bw = await b.ok("/api/workspace");
  profiles.push(aw.id, bw.id);
  assert.ok(a.cookie && b.cookie && a.cookie !== b.cookie);
  assert.notEqual(aw.id, bw.id);
  assert.equal((await a.ok("/api/workspace")).id, aw.id, "identity persists across requests");
  await a.ok("/api/workspace", { displayName: "Isolation visitor A", favorites: ["ashen-crown"], reading: { textScale: "large", measure: "wide", theme: "sepia", motion: "reduced" } }, "PATCH");
  assert.deepEqual(await b.ok("/api/workspace"), bw, "A cannot change B reading preferences");
  await a.ok("/api/settings", { keysText: "fake-isolation-key-visitor-A-1234", append: false, useLiveAI: false, embeddingsEnabled: false, semanticExtractionEnabled: false, dailyFlashLimit: 123 });
  await b.ok("/api/settings", { clearKeys: true, useLiveAI: false, embeddingsEnabled: false, semanticExtractionEnabled: false, dailyFlashLimit: 456 });
  const ac = await a.ok("/api/settings"), bc = await b.ok("/api/settings");
  assert.equal(ac.keysCount, 1); assert.equal(bc.keysCount, 0);
  assert.equal(ac.dailyFlashLimit, 123); assert.equal(bc.dailyFlashLimit, 456);
  assert.equal(ac.envKeysCount, 0); assert.equal(bc.envKeysCount, 0);
  assert.equal(ac.useLiveAI, false); assert.equal(bc.useLiveAI, false);
  assert.ok(!JSON.stringify(ac).includes("fake-isolation-key-visitor-A-1234"));
  await a.ok("/api/developer/typesafe", { key: "fake-typesafe-visitor-A-1234", pilotEnabled: false });
  assert.equal((await a.ok("/api/developer/typesafe")).storedConfigured, true);
  assert.equal((await b.ok("/api/developer/typesafe")).configured, false);
  console.log("PASS independent identity cookies, reading preferences, Gemini keys/limits and TypeSafe keys");

  const created = await a.ok("/api/sessions", { mode: "preset", scenarioId: "ashen-crown", characterIndex: 0 });
  const id = created.session.id;
  campaigns.push({ visitor: a, id });
  assert.equal(created.session.visibility, "private");
  assert.equal(created.session.ownerId, aw.id);
  assert.ok((await a.ok("/api/sessions")).sessions.some((s: Json) => s.id === id));
  assert.ok(!(await b.ok("/api/sessions")).sessions.some((s: Json) => s.id === id));
  assert.ok(!(await b.ok("/api/sessions?scope=public")).sessions.some((s: Json) => s.id === id));
  const snapshot = await a.ok(`/api/sessions/${id}`);
  const checkpoint = await a.ok(`/api/sessions/${id}/checkpoints`, { title: "Isolation checkpoint", expectedTurn: snapshot.session.turnCount, requestId: randomUUID() });
  const cp = checkpoint.checkpoint.id;
  const readPaths = ["", "/turns?before=999", "/export"];
  const ownerPaths = ["/memories", "/memory/search?q=isolation", "/checkpoints", `/requests/${randomUUID()}`];
  const mutations: [string, unknown, string][] = [
    ["", { title: "Intrusion" }, "PATCH"], ["", { visibility: "public" }, "PATCH"], ["", undefined, "DELETE"],
    ["/act", { action: "Inspect", custom: true, requestId: randomUUID() }, "POST"],
    ["/compact", {}, "POST"], ["/memory/reindex", {}, "POST"],
    ["/checkpoints", { title: "Intrusion", expectedTurn: snapshot.session.turnCount }, "POST"],
    [`/checkpoints/${cp}`, undefined, "DELETE"], [`/checkpoints/${cp}/fork`, { title: "Intrusion" }, "POST"],
  ];
  for (const suffix of [...readPaths, ...ownerPaths]) await denied(b, `/api/sessions/${id}${suffix}`);
  for (const [suffix, body, method] of mutations) await denied(b, `/api/sessions/${id}${suffix}`, body, method);
  console.log("PASS private campaign omitted from lists and denied on all nested read/mutation routes");

  await a.ok(`/api/sessions/${id}`, { visibility: "public" }, "PATCH");
  assert.ok((await b.ok("/api/sessions?scope=public")).sessions.some((s: Json) => s.id === id));
  assert.ok(!(await b.ok("/api/sessions")).sessions.some((s: Json) => s.id === id));
  for (const suffix of readPaths) await b.ok(`/api/sessions/${id}${suffix}`);
  assert.equal((await b.ok(`/api/sessions/${id}`)).isOwner, false);
  for (const suffix of ownerPaths) await denied(b, `/api/sessions/${id}${suffix}`);
  for (const [suffix, body, method] of mutations) await denied(b, `/api/sessions/${id}${suffix}`, body, method);
  assert.equal((await a.ok(`/api/sessions/${id}`)).session.turnCount, snapshot.session.turnCount);
  await a.ok(`/api/sessions/${id}`, { visibility: "private" }, "PATCH");
  for (const suffix of readPaths) await denied(b, `/api/sessions/${id}${suffix}`);
  assert.ok(!(await b.ok("/api/sessions?scope=public")).sessions.some((s: Json) => s.id === id));
  const branch = await a.ok(`/api/sessions/${id}/checkpoints/${cp}/fork`, { title: "Isolation owner branch", requestId: randomUUID() });
  campaigns.push({ visitor: a, id: branch.session.id });
  assert.equal(branch.session.ownerId, aw.id); assert.equal(branch.session.visibility, "private");
  await denied(b, `/api/sessions/${branch.session.id}`);
  const second = await b.ok("/api/sessions", { mode: "preset", scenarioId: "ashen-crown", characterIndex: 0 });
  campaigns.push({ visitor: b, id: second.session.id });
  await b.ok(`/api/sessions/${second.session.id}`, { title: "B owns this" }, "PATCH");
  await denied(a, `/api/sessions/${second.session.id}`);
  assert.equal((await a.ok("/api/system/status")).campaigns, 2);
  assert.equal((await b.ok("/api/system/status")).campaigns, 1);
  console.log("PASS publish/read-only/unpublish, owner checkpoint fork and symmetric campaign ownership");

  if (pool) {
    // Deterministic fixtures avoid sending fake credentials to external providers.
    for (const [owner, session, total] of [[aw.id, id, 111], [bw.id, second.session.id, 222]] as const) {
      const log = randomUUID(); seededLogs.push(log);
      await pool.query("insert into token_logs(id,owner_id,session_id,model,task_type,total_tokens) values($1,$2,$3,'isolation-fixture','test',$4)", [log, owner, session, total]);
      await pool.query("insert into memory_jobs(session_id,turn_number,kind,payload,status,typesafe_report) values($1,999,'isolation-fixture','{}','completed',$2)", [session, JSON.stringify({ status: "ok", isolationMarker: owner })]);
      await pool.query("insert into memory_jobs(session_id,turn_number,kind,payload,status) values($1,998,'isolation-retry','{}','failed')", [session]);
    }
    for (const [visitor, owner, total] of [[a, aw.id, 111], [b, bw.id, 222]] as const) {
      const stats = await visitor.ok("/api/tokens/stats");
      assert.equal(stats.today.totalTokens, total);
      assert.ok(stats.recent.every((row: Json) => row.ownerId === owner));
      const reports = await visitor.ok("/api/developer/typesafe/results");
      assert.equal(reports.results.length, 1);
      assert.equal(reports.results[0].report.isolationMarker, owner);
      const status = await visitor.ok("/api/system/status");
      const ownedIds = campaigns.filter(c => c.visitor === visitor).map(c => c.id);
      assert.ok(status.recentJobs.every((job: Json) => ownedIds.includes(job.sessionId)));
    }
    assert.equal((await a.ok("/api/system/process", { action: "retry" })).queued, 1);
    const retryRows = await pool.query("select session_id,status from memory_jobs where session_id = any($1::uuid[]) and kind = 'isolation-retry'", [[id, second.session.id]]);
    assert.equal(retryRows.rows.find(row => row.session_id === id)?.status, "pending");
    assert.equal(retryRows.rows.find(row => row.session_id === second.session.id)?.status, "failed");
    console.log("PASS token statistics, TypeSafe reports, system status and retry jobs scoped to owner");
  } else console.log("SKIP telemetry fixture checks: set DATABASE_URL for full verification");

  await denied(b, `/api/sessions/${id}/copy`, { requestId: randomUUID() });
  await a.ok(`/api/sessions/${id}`, { visibility: "public" }, "PATCH");
  await b.ok("/api/settings", { embeddingDims: 256 });
  const sourceBeforeCopy = await a.ok(`/api/sessions/${id}`);
  assert.equal((await b.call(`/api/sessions/${id}/copy`, {})).status, 400, "Copy requires a retry-safe request ID");
  const copyRequest = { requestId: randomUUID() };
  const copied = await b.ok(`/api/sessions/${id}/copy`, copyRequest);
  const copyId = copied.session.id;
  campaigns.push({ visitor: b, id: copyId });
  assert.equal(copied.replay, false);
  assert.equal(copied.session.ownerId, bw.id); assert.equal(copied.session.visibility, "private");
  assert.notEqual(copyId, id);
  const replayCopy = await b.ok(`/api/sessions/${id}/copy`, copyRequest);
  assert.equal(replayCopy.replay, true); assert.equal(replayCopy.session.id, copyId);
  const parallelRequest = { requestId: randomUUID() };
  const parallel = await Promise.all([b.call(`/api/sessions/${id}/copy`, parallelRequest), b.call(`/api/sessions/${id}/copy`, parallelRequest)]);
  for (const result of parallel) if (result.data.session?.id && !campaigns.some(c => c.id === result.data.session.id)) campaigns.push({ visitor: b, id: result.data.session.id });
  assert.deepEqual(parallel.map(result => result.status).sort(), [200, 201], "Concurrent duplicate requests create exactly one copy");
  assert.equal(parallel[0].data.session.id, parallel[1].data.session.id);
  assert.deepEqual(parallel.map(result => result.data.replay).sort(), [false, true]);
  await denied(a, `/api/sessions/${copyId}`);
  await denied(a, `/api/sessions/${copyId}`, { title: "Author cannot edit another player's copy" }, "PATCH");
  await denied(a, `/api/sessions/${copyId}/act`, { action: "Inspect", custom: true });
  assert.ok(!(await a.ok("/api/sessions")).sessions.some((session: Json) => session.id === copyId));
  assert.ok((await b.ok("/api/sessions")).sessions.some((session: Json) => session.id === copyId));
  assert.equal((await b.ok("/api/settings")).keysCount, 0);
  assert.equal((await b.ok("/api/developer/typesafe")).configured, false);
  const personal = await b.ok(`/api/sessions/${copyId}`);
  assert.deepEqual(personal.session.character, sourceBeforeCopy.session.character);
  assert.deepEqual(personal.session.worldState, sourceBeforeCopy.session.worldState);
  assert.equal(personal.session.turnCount, sourceBeforeCopy.session.turnCount);
  assert.deepEqual(personal.turns.map((turn: Json) => turn.content), sourceBeforeCopy.turns.map((turn: Json) => turn.content));
  for (const collection of ["turns", "memories", "inventory", "locations", "quests", "npcs", "sceneObjects"]) {
    assert.equal(personal[collection].length, sourceBeforeCopy[collection].length, `${collection} copied`);
    const sourceIds = new Set(sourceBeforeCopy[collection].map((row: Json) => row.id));
    assert.ok(personal[collection].every((row: Json) => row.sessionId === copyId && !sourceIds.has(row.id)), `${collection} remapped to private copy`);
  }
  assert.equal((await b.ok(`/api/sessions/${copyId}/checkpoints`)).checkpoints.length, 0);
  if (pool) {
    for (const table of ["token_logs", "memory_jobs", "turn_requests"]) {
      assert.equal((await pool.query(`select count(*)::int n from ${table} where session_id=$1`, [copyId])).rows[0].n, 0, `${table} should not be inherited`);
    }
    const embeddings = (await pool.query("select dims,status from memory_embeddings where session_id=$1", [copyId])).rows;
    assert.ok(embeddings.length > 0);
    assert.ok(embeddings.every(row => row.dims === 256 && row.status === "pending"), "Copied vectors must be queued in the new owner's vector space");
  }
  await b.ok(`/api/sessions/${copyId}/act`, { action: "Осмотреть место и продолжить свою историю", custom: true, requestId: randomUUID(), expectedTurn: personal.session.turnCount });
  const progressed = await b.ok(`/api/sessions/${copyId}`);
  assert.equal(progressed.session.turnCount, personal.session.turnCount + 1);
  const sourceAfterCopy = await a.ok(`/api/sessions/${id}`);
  assert.deepEqual(sourceAfterCopy.session, sourceBeforeCopy.session, "Personal progress must not change source campaign");
  assert.deepEqual(sourceAfterCopy.turns, sourceBeforeCopy.turns, "Personal progress must not append source history");
  await a.ok(`/api/sessions/${id}`, { visibility: "private" }, "PATCH");
  await denied(b, `/api/sessions/${id}/copy`, copyRequest);
  assert.equal((await b.ok(`/api/sessions/${copyId}`)).session.turnCount, progressed.session.turnCount, "Unpublishing source must not revoke personal copy");

  const freeSource = await a.ok("/api/sessions", { mode: "free", visibility: "public", rulesProfile: "narrative", customScenario: { title: "Copy isolation free fixture", pitch: "A quiet journey", startLocation: "Harbour" }, customCharacter: { name: "Test traveller", archetype: "Traveller" } });
  campaigns.push({ visitor: a, id: freeSource.session.id });
  const freeCopy = await b.ok(`/api/sessions/${freeSource.session.id}/copy`, { requestId: randomUUID() });
  campaigns.push({ visitor: b, id: freeCopy.session.id });
  const noKeyTurn = await b.call(`/api/sessions/${freeCopy.session.id}/act`, { action: "Continue my own story", custom: true, requestId: randomUUID() });
  assert.equal(noKeyTurn.status, 409); assert.equal(noKeyTurn.data.code, "AI_REQUIRED");
  assert.equal((await b.ok(`/api/sessions/${freeCopy.session.id}`)).session.turnCount, freeCopy.session.turnCount);
  if (pool) assert.equal((await pool.query("select count(*)::int n from token_logs where session_id=any($1::uuid[])", [[freeSource.session.id, freeCopy.session.id]])).rows[0].n, 0, "No author's key usage for the new player's free campaign");
  console.log("PASS personal public-campaign copies: authorization, replay, remapped state, private ownership, own progress/credentials/vector dimensions, and no-key free-mode gate");
}
run().then(() => console.log("ALL USER ISOLATION CHECKS PASSED")).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (pool && seededLogs.length) await pool.query("delete from token_logs where id = any($1::uuid[])", [seededLogs]);
  for (const { visitor, id } of campaigns.reverse()) await visitor.ok(`/api/sessions/${id}`, undefined, "DELETE");
  for (const visitor of [a, b]) if (visitor.cookie) {
    await visitor.ok("/api/settings", { clearKeys: true, useLiveAI: false });
    await visitor.ok("/api/developer/typesafe", { clearKey: true, pilotEnabled: false });
  }
  if (pool && profiles.length) {
    await pool.query("delete from workspace_preferences where id = any($1::text[])", [profiles]);
    await pool.query("delete from ai_settings where id = any($1::text[])", [profiles]);
  }
  await pool?.end();
});
