/** Synthetic transport smoke only. Does not import database, settings, or campaign services. */
import { mkdir, writeFile } from "node:fs/promises";
import { callTextWithConfig } from "../src/lib/text-provider";
import { parseResolution, RESOLUTION_RESPONSE_SCHEMA } from "../src/lib/resolution";
const scenes = [
  { id: "ordinary", text: "Бытовая история без опасности и бросков. Игрок спрашивает соседа, когда откроется библиотека. Время неизвестно; сосед тоже не знает. Не придумывай расписание и не решай следующее действие игрока." },
  { id: "alien", text: "В мире разумных кристаллов нет еды и сна. Игрок любуется отражением света. Опиши спокойную реакцию мира без навязывания человеческой физиологии и без изменения ресурсов." },
  { id: "failed-action", text: "Игрок пытался открыть сундук. Сервер установил неудачу: сундук остаётся закрытым, предметы не получены. Опиши короткий исход, сохраняя выбор следующего действия за игроком." },
];
async function run() {
  if (!process.argv.includes("--live")) { console.log(JSON.stringify({ syntheticOnly: true, generationCases: scenes.length, model: "gemini-3.5-flash-lite", embeddingRequests: 1 })); return; }
  const key = (process.env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEYS?.split(/[\n,;]+/)[0])?.trim();
  if (!key) throw new Error("missing_key");
  const rows: Record<string, unknown>[] = [];
  let attempts = 0;
  for (const [index, scene] of scenes.entries()) {
    let streamed = "";
    try {
      const response = await callTextWithConfig({ textProvider: "gemini" }, {
        keys: [key], models: ["gemini-3.5-flash-lite"], system: "Ты рассказчик русскоязычной интерактивной истории. Верни JSON по схеме. narration — 2–3 предложения; choices — 2 коротких возможных действия. Не меняй состояние или ресурсы без основания. Это синтетическая тестовая сцена.",
        user: scene.text, responseSchema: RESOLUTION_RESPONSE_SCHEMA, maxTokens: 1600, temperature: 0.2, timeoutMs: 30000,
        beforeAttempt: async () => ++attempts <= 6,
        ...(index === 1 ? { onText: (delta: string) => { streamed += delta; } } : {}),
      });
      const parsed = parseResolution(response.text);
      rows.push({ id: scene.id, prompt: scene.text, ...response, parsedJson: parsed.parsedJson, warnings: parsed.warnings, streamMatches: index === 1 ? streamed === response.text : null });
      console.log(JSON.stringify({ id: scene.id, ok: parsed.parsedJson, latencyMs: response.latencyMs }));
    } catch { rows.push({ id: scene.id, error: "generation_failed" }); console.log(JSON.stringify({ id: scene.id, ok: false })); break; }
  }
  const started = Date.now();
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ model: "models/gemini-embedding-2", content: { parts: [{ text: "В библиотеке хранится карта приливов." }] }, outputDimensionality: 768 }),
    });
    if (!response.ok) { await response.body?.cancel(); rows.push({ id: "embedding", httpStatus: response.status, ok: false }); }
    else {
      const data = await response.json();
      const values: unknown = data.embedding?.values;
      rows.push({ id: "embedding", model: "gemini-embedding-2", dimensions: Array.isArray(values) ? values.length : null,
        ok: Array.isArray(values) && values.length === 768 && values.every(v => typeof v === "number" && Number.isFinite(v)), latencyMs: Date.now() - started });
    }
  } catch { rows.push({ id: "embedding", ok: false, error: "embedding_failed" }); }
  await mkdir("output/provider-evaluation", { recursive: true });
  const path = `output/provider-evaluation/gemini-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(path, JSON.stringify({ syntheticOnly: true, databaseUsed: false, attempts, rows }, null, 2));
  console.log(JSON.stringify({ path, attempts, embedding: rows.at(-1) }));
  if (rows.some(row => row.error || row.ok === false || row.parsedJson === false || row.streamMatches === false)) process.exitCode = 1;
}
run().catch(() => { console.error("Synthetic smoke failed; raw errors suppressed."); process.exitCode = 1; });
