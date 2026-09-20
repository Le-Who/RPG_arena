import { test } from "node:test";
import assert from "node:assert/strict";
test("narration preview decodes only complete escapes and never exposes JSON state", async () => {
  const { narrationPreview } = await import('../src/lib/turn-stream');
  assert.equal(narrationPreview('{"narration":"Вы видите \\"'), 'Вы видите "');
  assert.equal(narrationPreview('{"narration":"Лес\\u002'), 'Лес');
  assert.equal(narrationPreview('{"narration":"Лес\\n🌲","stateChanges":{"gold":3}}'), 'Лес\n🌲');
  assert.equal(narrationPreview('{"narration":"Лес\\'), 'Лес');
});
test("NDJSON turn reader handles split UTF8 and rejects EOF without committed result", async () => {
  const { readTurnStream } = await import('../src/lib/turn-stream');
  const events: unknown[] = [];
  const bytes = new TextEncoder().encode('{"type":"narration","text":"Лес 🌲"}\n{"type":"committed","result":{"ok":true,"turnNumber":2}}\n');
  const response = new Response(new ReadableStream({start(c){ for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); }}));
  const result = await readTurnStream(response, e => events.push(e));
  assert.equal(result.turnNumber, 2); assert.equal(events.length, 2);
  await assert.rejects(readTurnStream(new Response('{"type":"narration","text":"Черновик"}\n'), () => {}), /STREAM_INTERRUPTED/);
});
