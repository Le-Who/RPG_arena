import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyMigrations } from "../scripts/lib/apply-migrations";
import { fetchPollinationsImageModels, parseImageModels } from "../src/lib/visual-models";

test("admin model choices contain only official text-to-image endpoint models", () => {
  const eligible = { name: "vendor/fast-image", title: "Fast Image", category: "image", community: false, input_modalities: ["text"], output_modalities: ["image"], supported_endpoints: ["/image/{prompt}"], paid_only: true };
  assert.deepEqual(parseImageModels([
    eligible,
    { ...eligible, name: "vendor/video", output_modalities: ["video"] },
    { ...eligible, name: "vendor/community", community: true },
    { ...eligible, name: "vendor/edit", input_modalities: ["image"] },
    { ...eligible, name: "vendor/unsupported", supported_endpoints: ["/v1/images/edits"] },
    { ...eligible, name: "<script>" },
  ]), [{ id: "vendor/fast-image", title: "Fast Image", paidOnly: true }]);
});

test("catalogue downloads are bounded before parsing external model data", async () => {
  const huge = async () => new Response("[]", { headers: { "content-length": String(600 * 1024) } });
  await assert.rejects(fetchPollinationsImageModels(huge as typeof fetch), /POLLINATIONS_CATALOG_TOO_LARGE/);
});

test("visual model selection has one durable row in the append-only migration ledger", async () => {
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  const client = { query: async (sql: string, values?: unknown[]) => values ? pg.query(sql, values) : (await pg.exec(sql)).at(-1)! };
  try {
    const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
    assert.equal(migrations.at(-1)?.folderMillis, 1790000000011);
    await applyMigrations(client, migrations);
    await pg.query("INSERT INTO visual_settings(id, model) VALUES (1, 'vendor/fast-image')");
    await assert.rejects(pg.query("INSERT INTO visual_settings(id, model) VALUES (2, 'vendor/other')"), /check constraint/i);
    const rows = await pg.query<{ model: string }>("SELECT model FROM visual_settings");
    assert.equal(rows.rows[0].model, "vendor/fast-image");
  } finally { await pg.close(); }
});
