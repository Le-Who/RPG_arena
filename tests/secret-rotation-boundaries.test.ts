import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { rotateSecrets } from "../src/lib/secret-rotation";
import { openSecret, sealSecret, secretContext, type SecretKeyring } from "../src/lib/secret-vault";

const ring: SecretKeyring = {
  active: "current",
  keys: { current: Buffer.alloc(32, 17).toString("base64"), previous: Buffer.alloc(32, 23).toString("base64") },
};
const previousRing = { ...ring, active: "previous" };
const currentOnly: SecretKeyring = { active: "current", keys: { current: ring.keys.current } };
const broken = "enc:v1:unavailable:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA";

type Row = {
  id: string; keys: string[] | null; typesafe_key: string; narrative_guard_provider: string;
  narrative_guard_key: string; openrouter_key: string; pollinations_key: string;
};

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE ai_settings(
    id text PRIMARY KEY, keys jsonb DEFAULT '[]'::jsonb,
    typesafe_key text NOT NULL DEFAULT '', narrative_guard_provider text NOT NULL DEFAULT 'openrouter',
    narrative_guard_key text NOT NULL DEFAULT '', openrouter_key text NOT NULL DEFAULT '',
    pollinations_key text NOT NULL DEFAULT '', updated_at timestamp NOT NULL DEFAULT '2000-01-01',
    unrelated_setting text NOT NULL DEFAULT 'keep-me'
  )`);
  return pg;
}

function sealed(owner: string, purpose: string, value: string, keyring = previousRing) {
  return sealSecret(value, secretContext(owner, purpose), keyring);
}

async function insertProfile(pg: PGlite, id: string) {
  await pg.query(`INSERT INTO ai_settings(id, keys, typesafe_key, narrative_guard_key, openrouter_key, pollinations_key)
    VALUES ($1,$2::jsonb,$3,$4,$5,$6)`, [id, JSON.stringify([sealed(id, "gemini", "gemini-synthetic")]),
    sealed(id, "typesafe-pilot", "typesafe-synthetic"), sealed(id, "narrative:openrouter", "narrative-synthetic"),
    sealed(id, "text:openrouter", "openrouter-synthetic"), sealed(id, "text:pollinations", "pollinations-synthetic")]);
}

async function snapshot(pg: PGlite) {
  return (await pg.query<Row>("SELECT * FROM ai_settings ORDER BY id")).rows;
}

function assertUsable(row: Row) {
  const entries = [
    [row.keys![0], "gemini", "gemini-synthetic"],
    [row.typesafe_key, "typesafe-pilot", "typesafe-synthetic"],
    [row.narrative_guard_key, "narrative:openrouter", "narrative-synthetic"],
    [row.openrouter_key, "text:openrouter", "openrouter-synthetic"],
    [row.pollinations_key, "text:pollinations", "pollinations-synthetic"],
  ];
  for (const [value, purpose, plaintext] of entries) {
    assert.equal(openSecret(value, secretContext(row.id, purpose), { keyring: currentOnly }), plaintext);
    assert.throws(() => openSecret(value, secretContext("other-owner", purpose), { keyring: currentOnly }));
  }
}

// Removing any protected SQL predicate would silently overwrite the corresponding concurrent edit.
// Interception changes real SQL state immediately before the genuine production UPDATE; it does not
// emulate rowCount, SQL comparison behavior, or a second database connection.
const concurrentEdits = [
  { name: "Gemini array", sql: "UPDATE ai_settings SET keys='[\"concurrent-gemini\"]'::jsonb WHERE id='a'" },
  { name: "Gemini array to SQL NULL", sql: "UPDATE ai_settings SET keys=NULL WHERE id='a'" },
  { name: "Gemini SQL NULL to array", initiallyNull: true, sql: "UPDATE ai_settings SET keys='[\"concurrent-gemini\"]'::jsonb WHERE id='a'" },
  { name: "TypeSafe key", sql: "UPDATE ai_settings SET typesafe_key='concurrent-typesafe' WHERE id='a'" },
  { name: "narrative key", sql: "UPDATE ai_settings SET narrative_guard_key='concurrent-narrative' WHERE id='a'" },
  { name: "narrative provider alone", sql: "UPDATE ai_settings SET narrative_guard_provider='typesafe' WHERE id='a'" },
  { name: "OpenRouter key", sql: "UPDATE ai_settings SET openrouter_key='concurrent-openrouter' WHERE id='a'" },
  { name: "Pollinations key", sql: "UPDATE ai_settings SET pollinations_key='concurrent-pollinations' WHERE id='a'" },
  { name: "profile deletion", sql: "DELETE FROM ai_settings WHERE id='a'" },
];

for (const edit of concurrentEdits) {
  test(`rotation aborts without clobbering a concurrent ${edit.name} or touching later rows`, async () => {
    const pg = await fixture();
    try {
      await insertProfile(pg, "a");
      await insertProfile(pg, "b");
      if (edit.initiallyNull) await pg.exec("UPDATE ai_settings SET keys=NULL WHERE id='a'");
      let expected: Row[] | undefined;
      await assert.rejects(() => rotateSecrets({
        mode: "apply", keyring: ring, batchSize: 2,
        query: async (text, params) => {
          if (!expected && text.startsWith("UPDATE ai_settings SET")) {
            await pg.exec(edit.sql);
            expected = await snapshot(pg);
          }
          return pg.query(text, params);
        },
      }), /changed concurrently/);
      assert.ok(expected, "the concurrent edit must occur before a real rotation UPDATE");
      assert.deepEqual(await snapshot(pg), expected, "retain every credential, timestamp, unrelated field and later row");
    } finally { await pg.close(); }
  });
}

test("rotation traverses mixed keyset batches and migrates plaintext only after explicit opt-in", async () => {
  const pg = await fixture();
  try {
    // Intentionally insert out of order: both skipped rows and successfully rotated rows advance the cursor.
    const active = sealed("a-active", "gemini", "already-active", ring);
    const old = sealed("m-old", "typesafe-pilot", "old-typesafe");
    await pg.query("INSERT INTO ai_settings(id,keys) VALUES ('z-legacy','[\"legacy-gemini\"]'::jsonb)");
    await pg.query("INSERT INTO ai_settings(id,typesafe_key) VALUES ('m-old',$1)", [old]);
    await pg.query("INSERT INTO ai_settings(id,keys) VALUES ('a-active',$1::jsonb)", [JSON.stringify([active])]);
    await pg.exec("INSERT INTO ai_settings(id,keys) VALUES ('b-blank',NULL)");
    const original = await snapshot(pg);
    await assert.rejects(() => rotateSecrets({ mode: "apply", keyring: ring, batchSize: 2,
      query: (text, params) => pg.query(text, params),
    }), { code: "SECRET_MIGRATION_REQUIRED" });
    const partial = await snapshot(pg);
    assert.deepEqual(partial.slice(0, 2), original.slice(0, 2));
    assert.deepEqual(partial[3], original[3], "plaintext row remains byte-for-byte unchanged without opt-in");
    assert.equal(openSecret(partial[2].typesafe_key, secretContext("m-old", "typesafe-pilot"), { keyring: currentOnly }), "old-typesafe");

    const report = await rotateSecrets({ mode: "apply", keyring: ring, allowPlaintext: true, batchSize: 2,
      query: (text, params) => pg.query(text, params),
    });
    assert.deepEqual(report, { mode: "apply", profiles: 4, credentials: 3, plaintext: 1, needsRotation: 1, updatedProfiles: 1 });
    const migrated = await snapshot(pg);
    assert.deepEqual(migrated.slice(0, 3), partial.slice(0, 3), "active, blank and previously completed rows are not rewritten");
    assert.equal(migrated[0].keys![0], active);
    assert.equal(migrated[1].keys, null);
    assert.equal(openSecret(migrated[3].keys![0], secretContext("z-legacy", "gemini"), { keyring: currentOnly }), "legacy-gemini");
    const rerun = await rotateSecrets({ mode: "apply", keyring: currentOnly, batchSize: 2,
      query: (text, params) => pg.query(text, params),
    });
    assert.deepEqual(rerun, { mode: "apply", profiles: 4, credentials: 3, plaintext: 0, needsRotation: 0, updatedProfiles: 0 });
    assert.deepEqual(await snapshot(pg), migrated);
  } finally { await pg.close(); }
});

// An UPDATE performed before the final credential decrypts would corrupt the failing profile;
// continuing after the error would rotate c. A global rollback would incorrectly undo a.
for (const batchSize of [1, 2]) {
  test(`late unreadable credential preserves its whole profile and recoverable earlier progress (batch ${batchSize})`, async () => {
    const pg = await fixture();
    try {
      for (const id of ["a", "b", "c"]) await insertProfile(pg, id);
      await pg.query("UPDATE ai_settings SET pollinations_key=$1 WHERE id='b'", [broken]);
      const original = await snapshot(pg);
      await assert.rejects(() => rotateSecrets({ mode: "apply", keyring: ring, batchSize,
        query: (text, params) => pg.query(text, params),
      }), { code: "SECRET_DECRYPTION_FAILED" });
      const partial = await snapshot(pg);
      assertUsable(partial[0]);
      assert.deepEqual(partial.slice(1), original.slice(1), "late failure leaves b entirely unchanged and never starts c");

      await pg.query("UPDATE ai_settings SET pollinations_key=$1 WHERE id='b'", [sealed("b", "text:pollinations", "pollinations-synthetic")]);
      const report = await rotateSecrets({ mode: "apply", keyring: ring, batchSize,
        query: (text, params) => pg.query(text, params),
      });
      assert.deepEqual(report, { mode: "apply", profiles: 3, credentials: 15, plaintext: 0, needsRotation: 10, updatedProfiles: 2 });
      const recovered = await snapshot(pg);
      assert.deepEqual(recovered[0], partial[0], "resuming must not reseal successful earlier credentials");
      recovered.forEach(assertUsable);
      const rerun = await rotateSecrets({ mode: "apply", keyring: currentOnly, batchSize,
        query: (text, params) => pg.query(text, params),
      });
      assert.deepEqual(rerun, { mode: "apply", profiles: 3, credentials: 15, plaintext: 0, needsRotation: 0, updatedProfiles: 0 });
      assert.deepEqual(await snapshot(pg), recovered, "idempotent rerun preserves ciphertext and timestamps");
    } finally { await pg.close(); }
  });
}
