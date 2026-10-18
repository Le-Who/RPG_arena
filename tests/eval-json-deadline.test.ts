import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readResponseJson } from "../scripts/lib/read-response-json";

test("evaluation JSON reader retains its deadline and cancels a partial body during forced GC", async () => {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", "--import", "./tests/helpers/test-environment.ts", "./tests/helpers/eval-json-deadline-worker.ts"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "", bodyTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => { child.kill(); reject(new Error(`worker did not reach body: ${output}`)); }, 10000);
      child.stdout.on("data", bytes => {
        output += String(bytes);
        if (!bodyTimer && output.includes("HEADERS_RECEIVED")) bodyTimer = setTimeout(() => { child.kill(); }, 2000);
      });
      child.stderr.on("data", bytes => { output += String(bytes); });
      child.on("error", error => { clearTimeout(timer); clearTimeout(bodyTimer); reject(error); });
      child.on("close", code => { clearTimeout(timer); clearTimeout(bodyTimer); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /HEADERS_RECEIVED/);
    assert.match(result.output, /TimeoutError|AbortError/);
    assert.match(result.output, /BODY_CANCELLED/);
    assert.doesNotMatch(result.output, /UNEXPECTED_SUCCESS|synthetic-body/);
});

test("evaluation JSON reader preserves a complete payload", async () => {
  assert.deepEqual(await readResponseJson(Response.json({ values: [1, 2, 3] }), AbortSignal.timeout(200)), { values: [1, 2, 3] });
});
