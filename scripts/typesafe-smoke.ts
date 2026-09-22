import { smokeFetch, smokeOwnerId, cleanupSmokeIdentity } from "./smoke-identity";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool } from "../src/db";
import { aiSettings, gameSessions, memoryJobs, memoryNodes, tokenLogs } from "../src/db/schema";
import { getAIConfig, getSettingsRow } from "../src/lib/ai-settings";
import { enqueueSemanticJob, processSemanticJob } from "../src/lib/memory-jobs";
import { assertMaskedSecretResponse, requireSharedIsolatedSecretKeyring } from "./lib/synthetic-secret-keyring";
import { sealSecret, secretContext } from "../src/lib/secret-vault";

const nativeFetch = globalThis.fetch;
const owned: string[] = [];
const smokeKeyring = requireSharedIsolatedSecretKeyring();

async function run() {
  const cfg = await getAIConfig(smokeOwnerId);
  const row = await getSettingsRow(smokeOwnerId);
  assert.ok(!cfg.keys.length && !row.typesafeKey && !process.env.TYPESAFE_API_KEY, "Use a disposable database without real provider credentials");
  const fake = { ...cfg, keys: ["mock"], canUseLive: true, useLiveAI: true, semanticExtractionEnabled: true, enforceLimits: false };
  for (const mode of ["disabled", "error", "ok", "stale"] as const) {
    const made = await smokeFetch(`${process.env.SMOKE_BASE_URL ?? "http://localhost:3010"}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "preset", scenarioId: "echo-station", characterIndex: 0 }) });
    assert.equal(made.status, 200);
    const { session } = await made.json(); owned.push(session.id);
    await db.update(aiSettings).set({ typesafeKey: sealSecret("mock-secret-typesafe", secretContext(smokeOwnerId, "typesafe-pilot"), smokeKeyring), typesafePilotEnabled: mode !== "disabled" }).where(eq(aiSettings.id, smokeOwnerId));
    const settingsResponse = await smokeFetch(`${process.env.SMOKE_BASE_URL ?? "http://localhost:3010"}/api/developer/typesafe`);
    const settingsView = await assertMaskedSecretResponse(settingsResponse, "mock-secret-typesafe") as { storedConfigured?: boolean; maskedKey?: string | null };
    assert.equal(settingsView.storedConfigured, true);
    assert.ok(settingsView.maskedKey);
    const phrase = "Навигатор обещает встретить героя у шлюза на рассвете.";
    await db.transaction(tx => enqueueSemanticJob(tx, { sessionId: session.id, turnNumber: 1, payload: { narration: phrase, playerAction: "Попросить о встрече", knownDigest: "", profileCanon: "Narrative" } }));
    await db.update(memoryJobs).set({ nextAttemptAt: new Date(0) }).where(eq(memoryJobs.sessionId, session.id));
    let jevCalls = 0;
    globalThis.fetch = async input => {
      if (String(input).includes("generativelanguage.googleapis.com")) return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ facts: [{ type: "promise", title: "Встреча", content: phrase, evidence: phrase, importance: 70, confidence: .9, entityKey: "test:jev" }] }) }] } }] });
      assert.equal(String(input), "https://api.typesafe.ai/v1/systemone"); jevCalls++;
      if (mode === "stale") await db.update(memoryJobs).set({ leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(memoryJobs.sessionId, session.id));
      if (mode === "error") return new Response("secret must not leak", { status: 503 });
      return Response.json({ model: "jev-1.13.0", answers: { fact0: { type: "choice", choice: "contradicts", probabilities: { supports: .1, contradicts: .8, unsupported: .1 }, confidence: .8 } }, usage: { input_tokens: 20, output_tokens: 2 } });
    };
    const result = await processSemanticJob({ sessionId: session.id, cfg: fake });
    const [job] = await db.select().from(memoryJobs).where(eq(memoryJobs.sessionId, session.id));
    const facts = await db.select().from(memoryNodes).where(and(eq(memoryNodes.sessionId, session.id), eq(memoryNodes.entityKey, "test:jev")));
    assert.equal(jevCalls, mode === "disabled" ? 0 : 1);
    assert.equal(facts.length, mode === "stale" ? 0 : 1);
    assert.equal(result.processed, mode === "stale" ? 0 : 1);
    assert.equal(job.typesafeReport?.status ?? null, mode === "disabled" || mode === "stale" ? null : mode);
    if (mode !== "stale") assert.equal(job.status, "completed");
    assert.ok(!JSON.stringify(job.typesafeReport).includes("secret"));
    console.log(`PASS: Jev ${mode} — canonical facts and fenced report`);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  globalThis.fetch = nativeFetch;
  if (owned.length) { await db.delete(tokenLogs).where(inArray(tokenLogs.sessionId, owned)); await db.delete(gameSessions).where(inArray(gameSessions.id, owned)); }
  await cleanupSmokeIdentity();
  await pool.end();
});
