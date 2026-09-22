import { pool } from "../src/db";
import { rotateSecrets, type SecretRotationMode } from "../src/lib/secret-rotation";
import { readSecretKeyring } from "../src/lib/secret-vault";

function requestedMode(args: string[]): SecretRotationMode {
  const modes = (["check", "dry-run", "apply"] as const).filter(mode => args.includes(`--${mode}`));
  if (modes.length !== 1) throw new Error("Usage: --check | --dry-run | --apply [--allow-plaintext]");
  const known = new Set(["--check", "--dry-run", "--apply", "--allow-plaintext"]);
  if (args.some(arg => !known.has(arg))) throw new Error("Unknown secret rotation option");
  return modes[0];
}

async function main() {
  const mode = requestedMode(process.argv.slice(2));
  const report = await rotateSecrets({
    mode,
    keyring: readSecretKeyring(),
    allowPlaintext: process.argv.includes("--allow-plaintext"),
    query: (text, params) => pool.query(text, params),
  });
  console.log(JSON.stringify(report));
}

main()
  .catch(() => {
    console.error("Secret rotation stopped. Check keyring, legacy opt-in and database access. No credentials were logged.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
