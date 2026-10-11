// Explicit opt-in, fixed disposable database, real Node exits and PostgreSQL connection failure.
import "../helpers/test-environment";
import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import type { TurnInput, TurnResponse } from "../../src/lib/turn-contract";

type Message = { kind: string; pid?: number; backendPid?: number; answer?: number; calls?: number; providerCalls?: number; code?: string; result?: TurnResponse & { code?: string } };
function worker(schema: string) {
  const application = `turn_recovery_worker_${randomUUID().replaceAll("-", "")}`;
  // Do not propagate NODE_OPTIONS, database defaults, vaults, provider secrets, or .env files.
  const env: NodeJS.ProcessEnv = { CHRONICLE_RUN_TURN_RECOVERY_POSTGRES: "1", NODE_ENV: "test" };
  for (const name of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name];
  const child = fork("tests/helpers/native-turn-recovery-worker.ts", [schema, application], {
    execArgv: ["--import", "tsx", "--import", "./tests/helpers/test-environment.ts"], env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", data => { output += String(data); });
  child.stderr?.on("data", data => { output += String(data); });
  const messages: Message[] = [];
  const consumed = new Set<Message>();
  const waiters = new Set<() => void>();
  child.on("message", message => { messages.push(message as Message); for (const notify of waiters) notify(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => { resolve({ code, signal }); for (const notify of waiters) notify(); }));
  async function next(kind: string): Promise<Message> {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const found = messages.find(message => message.kind === kind && !consumed.has(message));
      if (found) { consumed.add(found); return found; }
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Child exited before ${kind}: ${output}`);
      await new Promise<void>(resolve => {
        const timer = setTimeout(notify, 100);
        function notify() { clearTimeout(timer); waiters.delete(notify); resolve(); }
        waiters.add(notify);
      });
    }
    assert.fail(`Timed out waiting for ${kind}: ${output}`);
  }
  return { child, application, messages, exit, next, output: () => output };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}
const action = "Взломать замок на причале";
const character = { name: "Искатель", archetype: "Путник", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 5, stats: { ЛОВ: 12 }, skills: [], traits: [], conditions: [], backstory: "", appearance: "" };
const world = { worldName: "Гавань", tone: "Повседневность", era: "Сегодня", mainQuest: "Осмотреть причал", currentLocation: "Причал", factions: [], flags: {}, danger: 0, chapter: 1 };
// Independent hand-calculated oracle: floor(.6 * 20)+1=13, DEX12 => +1, danger0/turn2 => DC10.
const dice = { kind: "d20", d20: 13, modifier: 1, total: 14, dc: 10, success: true, critical: null, skill: "Взлом", band: "cost", label: "Успех 14 vs DC 10 (Взлом)", goal: action };

test("native process and backend loss recover admitted turns with their original dice", {
  skip: process.env.CHRONICLE_RUN_TURN_RECOVERY_POSTGRES !== "1", timeout: 90000,
}, async t => {
  for (const name of Object.keys(process.env)) if (name.startsWith("PG")) delete process.env[name];
  const schema = `turn_recovery_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^turn_recovery_[a-f0-9]{32}$/);
  const url = new URL("postgresql://chronicle_test:fixture-only@127.0.0.1:55439/chronicle_auth_test");
  const bootstrap = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  let created = false;
  let control: Pool | undefined;
  const children: ChildProcess[] = [];
  try {
    await bootstrap.query(`CREATE SCHEMA ${schema}`); created = true;
    url.searchParams.set("options", `-csearch_path=${schema},public -cstatement_timeout=15000`);
    control = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
    const sql = control;
    const migrations = (await readdir("drizzle")).filter(file => /^\d{4}_.*\.sql$/.test(file) && !file.startsWith("0006_")).sort();
    assert.equal(migrations.length, 19);
    for (const file of migrations) await sql.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    const launch = () => { const item = worker(schema); children.push(item.child); return item; };
    const seed = async (): Promise<TurnInput> => {
      const sessionId = randomUUID();
      await sql.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id,updated_at) VALUES ($1,'Process recovery fixture','free','d20',$2,$3,1,$4,'2026-01-01 00:00:00')", [sessionId, JSON.stringify(character), JSON.stringify(world), `recovery-owner-${sessionId}`]);
      return { sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action };
    };
    const snapshot = async (sessionId: string) => ({
      session: (await sql.query(`SELECT character,world_state,turn_count,context_tokens_estimate,to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at FROM game_sessions WHERE id=$1`, [sessionId])).rows[0],
      turns: (await sql.query("SELECT turn_number,role,content,request_id,dice FROM game_turns WHERE session_id=$1 ORDER BY turn_number,role", [sessionId])).rows,
      jobs: (await sql.query("SELECT turn_number,kind,status,payload FROM memory_jobs WHERE session_id=$1 ORDER BY turn_number,kind", [sessionId])).rows,
      scene: (await sql.query("SELECT name,state,location_name FROM scene_objects WHERE session_id=$1 ORDER BY key", [sessionId])).rows,
      memories: (await sql.query("SELECT entity_key,content,source_turn FROM memory_nodes WHERE session_id=$1 ORDER BY entity_key,content", [sessionId])).rows,
      embeddings: (await sql.query("SELECT status,attempts FROM memory_embeddings WHERE session_id=$1 ORDER BY id", [sessionId])).rows,
    });
    const initial = { session: { character, world_state: world, turn_count: 1, context_tokens_estimate: 0, updated_at: "2026-01-01T00:00:00" }, turns: [], jobs: [], scene: [], memories: [], embeddings: [] };
    const request = async (sessionId: string) => (await sql.query("SELECT id,request_id,status,stage,attempts,dice,result,error,lease_token,lease_expires_at FROM turn_requests WHERE session_id=$1", [sessionId])).rows;
    const recoverAndReplay = async (input: TurnInput, narration: string) => {
      const restarted = launch(); await restarted.next("ready");
      restarted.child.send({ kind: "run", input, rng: 0, narration });
      await restarted.next("provider");
      assert.deepEqual((await request(input.sessionId))[0].dice, dice);
      restarted.child.send({ kind: "release" });
      const response = await restarted.next("result");
      restarted.child.send({ kind: "stop" });
      assert.deepEqual(await restarted.exit, { code: 0, signal: null });
      assert.equal(response.result?.ok, true);
      const saved = await request(input.sessionId);
      assert.equal(saved.length, 1);
      assert.deepEqual({ ...saved[0], id: undefined, result: undefined }, { id: undefined, request_id: input.requestId, status: "completed", stage: "completed", attempts: 2, dice, result: undefined, error: null, lease_token: null, lease_expires_at: null });
      const committed = await snapshot(input.sessionId);
      assert.deepEqual(committed.session.character, { ...character, xp: 10 });
      assert.deepEqual(committed.session.world_state, { ...world, flags: { inspected: true }, danger: 1,
        clock: { day: 1, minute: 545 }, holdings: [], commitments: [], npcSchedules: [], agenda: [], npcAgendas: [], npcBonds: [], conditionTimers: {},
        story: { kind: "arc", goal: "Осмотреть причал", conflict: "", stakes: "", endCondition: "", status: "ongoing", focus: [] },
      });
      assert.equal(committed.session.turn_count, 2);
      assert.equal(committed.session.context_tokens_estimate, 20);
      assert.notEqual(committed.session.updated_at, initial.session.updated_at);
      assert.deepEqual(committed.turns, [
        { turn_number: 2, role: "narrator", content: narration, request_id: null, dice },
        { turn_number: 2, role: "player", content: action, request_id: input.requestId, dice: null },
      ]);
      assert.equal(committed.jobs.length, 1);
      assert.deepEqual({ ...committed.jobs[0], payload: undefined }, { turn_number: 2, kind: "semantic", status: "pending", payload: undefined });
      assert.equal(committed.jobs[0].payload.narration, narration);
      assert.equal(committed.jobs[0].payload.playerAction, action);
      assert.deepEqual(committed.scene, [{ name: "Тумба", state: "осмотрена", location_name: "Причал" }]);
      assert.deepEqual(committed.memories, [{ entity_key: "object:причал:тумба", content: "Тумба в «Причал» — состояние: осмотрена. Каменная тумба на причале. (ход 2)", source_turn: 2 }]);
      assert.deepEqual(committed.embeddings, [{ status: "pending", attempts: 0 }]);
      assert.deepEqual({ ok: saved[0].result.ok, requestId: saved[0].result.requestId, turnNumber: saved[0].result.turnNumber, dice: saved[0].result.dice, narration: saved[0].result.narration, choices: saved[0].result.choices, character: saved[0].result.state.character, flags: saved[0].result.state.worldState.flags, applied: saved[0].result.applied }, {
        ok: true, requestId: input.requestId, turnNumber: 2, dice, narration, choices: ["Продолжить прогулку"], character: { ...character, xp: 10 }, flags: { inspected: true },
        applied: { hp: 0, xp: 10, gold: 0, danger: 1, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [{ name: "Тумба", state: "осмотрена", isNew: true }], conditions: { added: [], removed: [] }, rejected: [],
          life: { clock: { from: "День 1, 09:00 (утро)", to: "День 1, 09:05 (утро)", minutes: 5, newDay: false }, transfers: [], commitments: [], story: null, intent: "act" },
          agenda: { scheduled: [], fired: [], cancelled: [], npcGoals: [] },
          social: { bonds: [], schedules: [], knowledge: [], missed: [], overdue: [] }, conditionTimers: { scheduled: [], expired: [] }, interaction: null,
          resources: { hp: { before: 20, after: 20, maxBefore: 20, maxAfter: 20 }, xp: { before: 0, after: 10 }, gold: { before: 5, after: 5 }, danger: { before: 0, after: 1 } },
        },
      });
      const replay = launch(); await replay.next("ready");
      replay.child.send({ kind: "run", input, rng: 0, narration: "Этот ответ не должен генерироваться." });
      const replayMessage = await replay.next("result");
      replay.child.send({ kind: "stop" });
      assert.deepEqual(await replay.exit, { code: 0, signal: null });
      assert.deepEqual(replayMessage.result, { ...saved[0].result, replay: true });
      assert.equal(replayMessage.providerCalls, 0);
      assert.equal(replay.messages.filter(message => message.kind === "provider").length, 0);
      assert.deepEqual(await request(input.sessionId), saved);
      assert.deepEqual(await snapshot(input.sessionId), committed);
    };

    await t.test("killed generation process leaves no canonical writes; restarted process retains request and dice", { timeout: 35000 }, async () => {
      // Catches dice recomputation on reacquisition, abandoned-request duplication, or partial early writes.
      const input = await seed();
      assert.deepEqual(await snapshot(input.sessionId), initial);
      const first = launch(); await first.next("ready");
      first.child.send({ kind: "run", input, rng: .6, narration: "Погибший процесс не должен записать этот текст." });
      await first.next("provider");
      const pending = await request(input.sessionId);
      assert.equal(pending.length, 1);
      assert.deepEqual({ ...pending[0], id: undefined, lease_token: undefined, lease_expires_at: undefined }, { id: undefined, request_id: input.requestId, status: "running", stage: "generation", attempts: 1, dice, result: null, error: null, lease_token: undefined, lease_expires_at: undefined });
      assert.ok(pending[0].lease_token);
      await stop(first.child);
      const stopped = await first.exit;
      assert.ok(stopped.signal !== null || stopped.code !== 0, "actual child process death must be observed");
      assert.deepEqual(await snapshot(input.sessionId), initial);
      assert.deepEqual(await request(input.sessionId), pending);
      const early = launch(); await early.next("ready");
      early.child.send({ kind: "run", input, rng: 0, narration: "Активная аренда не должна вызывать провайдера." });
      const busy = await early.next("result"); early.child.send({ kind: "stop" }); await early.exit;
      assert.equal(busy.result?.ok, false); assert.equal(busy.result?.code, "BUSY");
      assert.equal(busy.providerCalls, 0);
      assert.deepEqual(await request(input.sessionId), pending);
      // Controlled database expiry only; this fixture does not claim 90 seconds elapsed.
      await sql.query("UPDATE turn_requests SET lease_expires_at='2000-01-01 00:00:00' WHERE id=$1", [pending[0].id]);
      await recoverAndReplay(input, "После перезапуска ты осматриваешь замок.");
    });

    await t.test("terminated commit backend rolls back all writes before a fresh process retries", { timeout: 35000 }, async () => {
      // Catches canonical/outbox writes escaping the completion transaction or connection loss duplicating a commit.
      const input = await seed();
      assert.deepEqual(await snapshot(input.sessionId), initial);
      const lockKey = 732401;
      const locker = await sql.connect();
      let triggerCreated = false;
      try {
        await locker.query("SELECT pg_advisory_lock($1)", [lockKey]);
        await sql.query(`CREATE FUNCTION hold_fixture_completion() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.status = 'completed' THEN
              IF (SELECT turn_count FROM game_sessions WHERE id=NEW.session_id) <> 2
                OR (SELECT count(*) FROM game_turns WHERE session_id=NEW.session_id) <> 2
                OR (SELECT count(*) FROM memory_jobs WHERE session_id=NEW.session_id) <> 1
                OR (SELECT count(*) FROM scene_objects WHERE session_id=NEW.session_id) <> 1
                OR (SELECT count(*) FROM memory_nodes WHERE session_id=NEW.session_id) < 1
                OR (SELECT count(*) FROM memory_embeddings WHERE session_id=NEW.session_id) < 1 THEN
                RAISE EXCEPTION 'fixture reached completion without transactional writes';
              END IF;
              PERFORM pg_advisory_xact_lock(${lockKey});
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER hold_fixture_completion BEFORE UPDATE ON turn_requests FOR EACH ROW EXECUTE FUNCTION hold_fixture_completion();`);
        triggerCreated = true;
        const first = launch(); await first.next("ready");
        first.child.send({ kind: "run", input, rng: .6, narration: "Разорванное соединение не должно сохранить этот текст." });
        await first.next("provider"); first.child.send({ kind: "release" });
        let backendPid: number | undefined;
        const deadline = Date.now() + 12000;
        while (!backendPid && Date.now() < deadline) {
          backendPid = (await sql.query("SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name=$1 AND l.locktype='advisory' AND l.objid=$2 AND NOT l.granted", [first.application, lockKey])).rows[0]?.pid;
          if (!backendPid) await delay(25);
        }
        assert.ok(backendPid, "real backend must reach completion trigger after transactional writes");
        assert.deepEqual(await snapshot(input.sessionId), initial, "uncommitted writes are invisible on independent connection");
        assert.deepEqual((await sql.query("SELECT pg_terminate_backend($1) AS terminated", [backendPid])).rows, [{ terminated: true }]);
        const failure = await first.next("failure");
        assert.equal(failure.code, "INTERNAL");
        assert.equal(failure.providerCalls, 1);
        first.child.send({ kind: "probe" });
        const probe = await first.next("probe");
        assert.equal(probe.answer, 42, "same worker survives active connection failure and obtains a new connection");
        assert.notEqual(probe.backendPid, backendPid);
        first.child.send({ kind: "stop" });
        assert.deepEqual(await first.exit, { code: 0, signal: null });
        assert.deepEqual(await snapshot(input.sessionId), initial);
        const failed = await request(input.sessionId);
        assert.equal(failed.length, 1);
        assert.deepEqual({ ...failed[0], id: undefined }, { id: undefined, request_id: input.requestId, status: "failed", stage: "failed", attempts: 1, dice, result: null, error: "INTERNAL", lease_token: null, lease_expires_at: null });
        await sql.query("DROP TRIGGER hold_fixture_completion ON turn_requests; DROP FUNCTION hold_fixture_completion()");
        triggerCreated = false;
        await locker.query("SELECT pg_advisory_unlock($1)", [lockKey]);
        await recoverAndReplay(input, "После восстановления соединения замок осмотрен.");
      } finally {
        await locker.query("SELECT pg_advisory_unlock($1)", [lockKey]);
        locker.release();
        if (triggerCreated) await sql.query("DROP TRIGGER hold_fixture_completion ON turn_requests; DROP FUNCTION hold_fixture_completion()");
      }
    });

    await t.test("idle connection termination preserves a live worker and later turn commit", { timeout: 25000 }, async () => {
      // Catches uncaught pool error events between requests; no test error handler hides them.
      const input = await seed();
      const idle = launch(); await idle.next("ready");
      idle.child.send({ kind: "probe" });
      const initialProbe = await idle.next("probe");
      assert.equal(initialProbe.answer, 42);
      assert.deepEqual((await sql.query("SELECT pg_terminate_backend($1) AS terminated", [initialProbe.backendPid])).rows, [{ terminated: true }]);
      await idle.next("removed");
      idle.child.send({ kind: "probe" });
      const replacement = await idle.next("probe");
      assert.equal(replacement.answer, 42);
      assert.notEqual(replacement.backendPid, initialProbe.backendPid);
      assert.deepEqual(await snapshot(input.sessionId), initial);
      idle.child.send({ kind: "run", input, rng: .6, narration: "После замены простаивающего соединения ход сохранён." });
      await idle.next("provider"); idle.child.send({ kind: "release" });
      assert.equal((await idle.next("result")).result?.ok, true);
      idle.child.send({ kind: "stop" });
      assert.deepEqual(await idle.exit, { code: 0, signal: null });
      assert.doesNotMatch(idle.output(), /fixture-only|postgresql:\/\/|synthetic-recovery-provider|SELECT|UPDATE|INSERT/);
      assert.equal((await request(input.sessionId))[0].status, "completed");
      assert.equal((await snapshot(input.sessionId)).turns.length, 2);
      assert.equal((await snapshot(input.sessionId)).jobs.length, 1);
    });
  } finally {
    await Promise.all(children.map(stop));
    await control?.end();
    if (created) await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
    await bootstrap.end();
  }
});
