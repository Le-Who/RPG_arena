import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchFixtureBrowser } from "../scripts/lib/launch-fixture-browser";

async function listen(server: Server, port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

for (const mode of ["synchronous", "asynchronous"] as const) {
  test(`${mode} browser launch failure releases the real fixture listener and preserves the error`, async () => {
    const server = createServer();
    const replacement = createServer();
    const port = await listen(server);
    const failure = new Error("fixture browser cannot start");
    try {
      await assert.rejects(launchFixtureBrowser(server, () => {
        if (mode === "synchronous") throw failure;
        return Promise.reject(failure);
      }), error => error === failure);
      assert.equal(server.listening, false);
      await listen(replacement, port);
    } finally { await close(server); await close(replacement); }
  });
}

test("successful browser launch retains the fixture listener for browser requests", async () => {
  const server = createServer((_request, response) => response.end("fixture ready"));
  const port = await listen(server);
  const browser = {};
  try {
    assert.equal(await launchFixtureBrowser(server, async () => browser), browser);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "fixture ready");
  } finally { await close(server); }
});

test("fixture script exits with its missing-browser error instead of retaining the HTTP server", async () => {
  const browsers = await mkdtemp(join(tmpdir(), "chronicle-missing-browsers-"));
  try {
    const result = await new Promise<{ code: string | number | null | undefined; killed: boolean; stderr: string }>(resolve => {
      execFile(process.execPath, ["--import", "tsx", "--import", "./tests/helpers/test-environment.ts", "scripts/app-update-guards-browser.ts"], {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers }, timeout: 10000, killSignal: "SIGKILL",
      }, (error, _stdout, stderr) => resolve({ code: error?.code, killed: error?.killed ?? false, stderr }));
    });
    assert.equal(result.killed, false, "browser launch failed but the fixture server kept the process alive");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /browserType\.launch: Executable doesn't exist/);
  } finally { await rm(browsers, { recursive: true, force: true }); }
});
