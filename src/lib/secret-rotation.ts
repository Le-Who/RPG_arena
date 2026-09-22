import { isSealedSecret, openSecret, sealSecret, secretContext, secretNeedsRotation, type SecretKeyring } from "./secret-vault";

export type SecretRotationMode = "check" | "dry-run" | "apply";
export type SecretRotationReport = {
  mode: SecretRotationMode;
  profiles: number;
  credentials: number;
  plaintext: number;
  needsRotation: number;
  updatedProfiles: number;
};
type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number | null };
type Query = (text: string, params?: unknown[]) => Promise<QueryResult>;
type RawSettings = {
  id: string;
  keys: unknown;
  typesafe_key: string;
  narrative_guard_provider: string;
  narrative_guard_key: string;
};

export async function rotateSecrets(options: {
  mode: SecretRotationMode;
  keyring: SecretKeyring;
  allowPlaintext?: boolean;
  batchSize?: number;
  query: Query;
}): Promise<SecretRotationReport> {
  const { mode, keyring, query } = options;
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("Invalid secret rotation batch size");
  const report: SecretRotationReport = { mode, profiles: 0, credentials: 0, plaintext: 0, needsRotation: 0, updatedProfiles: 0 };
  let cursor = "";

  while (true) {
    const result = await query(
      "SELECT id, keys, typesafe_key, narrative_guard_provider, narrative_guard_key FROM ai_settings WHERE id > $1 ORDER BY id LIMIT $2",
      [cursor, batchSize],
    );
    const rows = result.rows as unknown as RawSettings[];
    if (rows.length === 0) break;
    for (const row of rows) {
      report.profiles++;
      if (row.keys !== null && (!Array.isArray(row.keys) || !row.keys.every(value => typeof value === "string"))) {
        throw new Error("Secret rotation stopped because of malformed stored Gemini credentials");
      }
      const rawKeys = row.keys ?? [];
      const entries = [
        ...rawKeys.map((value, index) => ({ value, purpose: "gemini", target: `key:${index}` })),
        { value: row.typesafe_key, purpose: "typesafe-pilot", target: "typesafe" },
        { value: row.narrative_guard_key, purpose: `narrative:${row.narrative_guard_provider}`, target: "narrative" },
      ];
      const nextKeys = [...rawKeys];
      let nextTypeSafe = row.typesafe_key;
      let nextNarrative = row.narrative_guard_key;
      let changed = false;

      for (const entry of entries) {
        if (!entry.value) continue;
        report.credentials++;
        if (!isSealedSecret(entry.value)) report.plaintext++;
        const plaintext = openSecret(entry.value, secretContext(row.id, entry.purpose), {
          keyring,
          allowPlaintext: options.allowPlaintext ?? false,
        });
        if (!secretNeedsRotation(entry.value, keyring.active)) continue;
        report.needsRotation++;
        if (mode !== "apply") continue;
        const sealed = sealSecret(plaintext, secretContext(row.id, entry.purpose), keyring);
        if (entry.target.startsWith("key:")) nextKeys[Number(entry.target.slice(4))] = sealed;
        else if (entry.target === "typesafe") nextTypeSafe = sealed;
        else nextNarrative = sealed;
        changed = true;
      }

      if (mode === "apply" && changed) {
        const nextKeysValue = row.keys === null ? null : JSON.stringify(nextKeys);
        const originalKeysValue = row.keys === null ? null : JSON.stringify(rawKeys);
        const updated = await query(
          `UPDATE ai_settings SET keys=$1::jsonb, typesafe_key=$2, narrative_guard_key=$3, updated_at=now()
           WHERE id=$4 AND keys IS NOT DISTINCT FROM $5::jsonb
             AND typesafe_key IS NOT DISTINCT FROM $6
             AND narrative_guard_provider IS NOT DISTINCT FROM $7
             AND narrative_guard_key IS NOT DISTINCT FROM $8`,
          [nextKeysValue, nextTypeSafe, nextNarrative, row.id, originalKeysValue, row.typesafe_key, row.narrative_guard_provider, row.narrative_guard_key],
        );
        if (updated.rowCount !== 1) throw new Error("Secret rotation stopped because settings changed concurrently");
        report.updatedProfiles++;
      }
    }
    cursor = rows[rows.length - 1].id;
  }
  return report;
}
