/** Administrator importer verification. Run only against a disposable DATABASE_URL. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const exec = promisify(execFile);
const profiles = [0, 1].map(() => `guest:${randomBytes(32).toString("hex")}`);
const sessions = [randomUUID(), randomUUID()];
const logs = [randomUUID(), randomUUID()];
let backupAI: Record<string, unknown> | undefined;
let backupWorkspace: Record<string, unknown> | undefined;
let backupsRead = false;
async function invoke(args: string[], expectedError?: RegExp) {
  try {
    const result = await exec(process.execPath, ["--import", "tsx", "scripts/assign-legacy-profile.ts", ...args]);
    assert.equal(expectedError, undefined, "Importer should reject this operation");
    assert.ok(!result.stdout.includes("fake-legacy-secret"), "Importer must never print credentials");
  } catch (error) {
    if (!expectedError) throw error;
    assert.match(String((error as { stderr?: string }).stderr), expectedError);
  }
}
async function run() {
  backupAI = (await pool.query("select * from ai_settings where id='global'")).rows[0];
  backupWorkspace = (await pool.query("select * from workspace_preferences where id='local'")).rows[0];
  backupsRead = true;
  await pool.query("delete from ai_settings where id='global'");
  await pool.query("delete from workspace_preferences where id='local'");
  await pool.query("insert into ai_settings(id,keys,typesafe_key,use_live_ai) values('global',$1,'fake-legacy-secret-typesafe',false)", [JSON.stringify(["fake-legacy-secret-gemini"])]);
  await pool.query("insert into workspace_preferences(id,display_name,favorites,reading) values('local','Legacy fixture',$1,$2)", [JSON.stringify(["ashen-crown"]), JSON.stringify({ textScale: "large", measure: "wide", theme: "sepia", motion: "reduced" })]);
  for (let i = 0; i < 2; i++) {
    await pool.query("insert into workspace_preferences(id) values($1)", [profiles[i]]);
    await pool.query("insert into ai_settings(id,keys) values($1,'[]')", [profiles[i]]);
    await pool.query("insert into game_sessions(id,title,visibility,character,world_state) values($1,'Legacy importer fixture','public','{}','{}')", [sessions[i]]);
    await pool.query("insert into token_logs(id,session_id,model,task_type) values($1,$2,'legacy-fixture','test')", [logs[i], sessions[i]]);
  }
  const args = [`--profile=${profiles[0]}`, `--campaign=${sessions[0]}`, "--include-settings"];
  await invoke(args);
  assert.equal((await pool.query("select owner_id from game_sessions where id=$1", [sessions[0]])).rows[0].owner_id, null);
  assert.equal((await pool.query("select owner_id from token_logs where id=$1", [logs[0]])).rows[0].owner_id, null);
  assert.deepEqual((await pool.query("select keys from ai_settings where id=$1", [profiles[0]])).rows[0].keys, []);
  assert.notEqual((await pool.query("select display_name from workspace_preferences where id=$1", [profiles[0]])).rows[0].display_name, "Legacy fixture");
  await invoke([...args, "--apply"]);
  const assigned = (await pool.query("select owner_id,visibility from game_sessions where id=$1", [sessions[0]])).rows[0];
  assert.deepEqual(assigned, { owner_id: profiles[0], visibility: "private" });
  assert.equal((await pool.query("select owner_id from token_logs where id=$1", [logs[0]])).rows[0].owner_id, profiles[0]);
  const importedAI = (await pool.query("select keys,typesafe_key from ai_settings where id=$1", [profiles[0]])).rows[0];
  assert.deepEqual(importedAI.keys, ["fake-legacy-secret-gemini"]);
  assert.equal(importedAI.typesafe_key, "fake-legacy-secret-typesafe");
  const workspace = (await pool.query("select display_name,favorites,reading from workspace_preferences where id=$1", [profiles[0]])).rows[0];
  assert.equal(workspace.display_name, "Legacy fixture"); assert.deepEqual(workspace.favorites, ["ashen-crown"]); assert.equal(workspace.reading.theme, "sepia");
  await invoke([`--profile=${profiles[1]}`, `--campaign=${sessions[0]}`, "--apply"], /have no owner/);
  await invoke([`--profile=${profiles[0]}`, `--campaign=${sessions[1]}`, "--include-settings", "--apply"], /already has credentials/);
  assert.equal((await pool.query("select owner_id from game_sessions where id=$1", [sessions[1]])).rows[0].owner_id, null, "Credential refusal must roll back campaign assignment");
  await pool.query("update ai_settings set typesafe_key='fake-target-existing-typesafe' where id=$1", [profiles[1]]);
  await invoke([`--profile=${profiles[1]}`, "--include-settings", "--apply"], /already has credentials/);
  assert.equal((await pool.query("select typesafe_key from ai_settings where id=$1", [profiles[1]])).rows[0].typesafe_key, "fake-target-existing-typesafe");
  await invoke([`--profile=${profiles[1]}`, `--campaign=${sessions[1]}`, "--apply"]);
  assert.equal((await pool.query("select owner_id from game_sessions where id=$1", [sessions[1]])).rows[0].owner_id, profiles[1]);
  assert.equal((await pool.query("select typesafe_key from ai_settings where id=$1", [profiles[1]])).rows[0].typesafe_key, "fake-target-existing-typesafe", "Campaign-only import leaves target settings intact");
  assert.equal((await pool.query("select count(*)::int n from ai_settings where id='global'")).rows[0].n, 1);
  assert.equal((await pool.query("select count(*)::int n from workspace_preferences where id='local'")).rows[0].n, 1);
  console.log("PASS legacy importer dry-run, private explicit assignment, token ownership, optional settings import, credential overwrite refusal/rollback, and already-owned refusal");
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await pool.query("delete from token_logs where id=any($1::uuid[])", [logs]);
  await pool.query("delete from game_sessions where id=any($1::uuid[])", [sessions]);
  await pool.query("delete from ai_settings where id=any($1::text[])", [profiles]);
  await pool.query("delete from workspace_preferences where id=any($1::text[])", [profiles]);
  if (backupsRead) {
    await pool.query("delete from ai_settings where id='global'");
    await pool.query("delete from workspace_preferences where id='local'");
    if (backupAI) await pool.query("insert into ai_settings select * from json_populate_record(null::ai_settings,$1::json)", [JSON.stringify(backupAI)]);
    if (backupWorkspace) await pool.query("insert into workspace_preferences select * from json_populate_record(null::workspace_preferences,$1::json)", [JSON.stringify(backupWorkspace)]);
  }
  await pool.end();
});
