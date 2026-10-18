import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const semver = require("semver") as {
  valid(version: string): string | null;
  satisfies(version: string, range: string): boolean;
};
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  engines: { node: string };
};
const pinned = readFileSync(new URL("../../.node-version", import.meta.url), "utf8").trim();

export function assertTestRuntime(version = process.versions.node): void {
  const range = manifest.engines.node;
  if (!semver.valid(pinned) || !semver.satisfies(pinned, range) || !semver.valid(version) || !semver.satisfies(version, range)) {
    throw Object.assign(new Error(
      `UNSUPPORTED_TEST_NODE: Node ${version} не входит в проверенный диапазон ${range}. ` +
      `Используйте Node ${pinned} из .node-version и выполните npm ci. ` +
      "Тесты остановлены до запуска PGlite: неподдерживаемый V8 может аварийно завершать WebAssembly.",
    ), { code: "UNSUPPORTED_TEST_NODE" });
  }
}
