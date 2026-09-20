import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { selectNarrativeChecks, type NarrativeVerdict } from "../src/lib/narrative-policy";
import { verifyNarrative } from "../src/lib/narrative-verifier";

// Frozen labels; evaluates the independence predicate alone, not complete turn approval.
type Scenario = { id: string; expected: NarrativeVerdict; state: Record<string, unknown> };
const development: Scenario[] = [
  { id: "failed_goal_disguised", expected: "contradicts", state: {
    dice: { goal: "Получить штаны у торговца", outcome: "failure" },
    provisional_independent_additions: [{ type: "inventory.add", name: "штаны", qty: 1, checkDependency: "independent" }],
    draft: "Торговец пожалел тебя и всё равно отдал штаны.",
  } },
  { id: "goal_operation_omitted_from_prose", expected: "contradicts", state: {
    dice: { goal: "Получить штаны у торговца", outcome: "failure" },
    provisional_independent_additions: [{ type: "inventory.add", name: "штаны", qty: 1 }], draft: "На площади тихо.",
  } },
  { id: "invented_unrelated_delivery", expected: "insufficient", state: {
    dice: { goal: "Открыть ворота", outcome: "failure" },
    provisional_independent_additions: [{ type: "inventory.add", name: "штаны", qty: 1 }],
    draft: "Курьер принёс давно заказанные штаны.",
    accepted_changes: { operations: [{ type: "inventory.add", name: "штаны", qty: 1 }] },
  } },
  { id: "confirmed_unconditional_delivery", expected: "consistent", state: {
    dice: { goal: "Открыть ворота", outcome: "failure" },
    historical_evidence: [{ authority: "confirmed_event", turnNumber: 8, text: "Герой оплатил одни штаны. В ход 10 курьер передаст их ему без каких-либо условий; доставка не зависит от ворот." }],
    provisional_independent_additions: [{ type: "inventory.add", name: "штаны", qty: 1 }],
  } },
  { id: "unsupported_extra_quantity", expected: "insufficient", state: {
    dice: { goal: "Открыть ворота", outcome: "failure" },
    historical_evidence: [{ authority: "confirmed_event", turnNumber: 8, text: "В ход 10 герой безусловно получит одну стрелу по оплаченному заказу. Других поставок не было." }],
    before_state: { inventory: [{ name: "стрела", qty: 2 }] },
    provisional_independent_additions: [{ type: "inventory.add", name: "стрела", qty: 3 }],
  } },
  { id: "legacy_claim_not_delivery_proof", expected: "insufficient", state: {
    dice: { goal: "Открыть ворота", outcome: "failure" },
    historical_evidence: [{ authority: "legacy_narration", turnNumber: 8, text: "В ход 10 курьер передаст тебе штаны.", acceptedChanges: [] }],
    provisional_independent_additions: [{ type: "inventory.add", name: "штаны", qty: 1 }],
  } },
];

// Separate examples authored before the comparator is evaluated on this set.
const heldout: Scenario[] = [
  { id: "return_borrowed_compass", expected: "consistent", state: {
    dice: { goal: "Убедить капитана дать лодку", outcome: "failure" },
    historical_evidence: [{ authority: "confirmed_event", turnNumber: 9, text: "Капитан уже распорядился вернуть герою его компас в ход 10 независимо от решения о лодке. Компас был одолжен капитану, а не предложен как награда." }],
    provisional_independent_additions: [{ type: "inventory.add", name: "компас", qty: 1 }],
  } },
  { id: "reward_for_failed_goal", expected: "contradicts", state: {
    dice: { goal: "Победить стража на турнире", outcome: "failure" },
    historical_evidence: [{ authority: "confirmed_event", turnNumber: 9, text: "Победитель стража получает серебряный кубок. Проигравший кубка не получает." }],
    provisional_independent_additions: [{ type: "inventory.add", name: "серебряный кубок", qty: 1 }],
  } },
  { id: "future_delivery", expected: "insufficient", state: {
    dice: { goal: "Взломать сундук", outcome: "failure" },
    historical_evidence: [{ authority: "confirmed_event", turnNumber: 9, text: "Поставка трёх стрел назначена на ход 12, не раньше." }],
    provisional_independent_additions: [{ type: "inventory.add", name: "стрела", qty: 3 }],
  } },
  { id: "two_valid_independent_items", expected: "consistent", state: {
    dice: { goal: "Выведать секрет кузнеца", outcome: "failure" },
    historical_evidence: [{ authority: "confirmed_event", turnNumber: 9, text: "Герой заранее оплатил один молоток и два гвоздя. Кузнец безусловно вручит заказ в ход 10. Это не зависит от его ответов на вопросы." }],
    provisional_independent_additions: [{ type: "inventory.add", name: "молоток", qty: 1 }, { type: "inventory.add", name: "гвоздь", qty: 2 }],
  } },
  { id: "mixed_supported_and_unsupported", expected: "insufficient", state: {
    dice: { goal: "Взломать сундук", outcome: "failure" },
    historical_evidence: [{ authority: "confirmed_event", turnNumber: 9, text: "В ход 10 курьер без условий передаст герою один факел из оплаченного заказа." }],
    provisional_independent_additions: [{ type: "inventory.add", name: "факел", qty: 1 }, { type: "inventory.add", name: "рубиновое кольцо", qty: 1 }],
  } },
  { id: "verified_npc_rumor", expected: "insufficient", state: {
    dice: { goal: "Открыть ворота", outcome: "failure" },
    historical_evidence: [{ authority: "verified_narration", turnNumber: 9, text: "Пьяница уверяет, что барон подарит герою коня в ход 10. Это неподтверждённый слух." }],
    provisional_independent_additions: [{ type: "inventory.add", name: "конь", qty: 1 }],
  } },
  { id: "independent_delivery_cancelled", expected: "contradicts", state: {
    dice: { goal: "Взломать сундук", outcome: "failure" },
    historical_evidence: [{ authority: "confirmed_event", turnNumber: 7, text: "Заказанный плащ доставят в ход 10." }, { authority: "confirmed_event", turnNumber: 9, text: "Заказ плаща отменён, деньги возвращены. Плащ не будет доставлен." }],
    provisional_independent_additions: [{ type: "inventory.add", name: "плащ", qty: 1 }],
  } },
  { id: "stack_increase_confirmed", expected: "consistent", state: {
    dice: { goal: "Открыть ворота", outcome: "failure" }, before_state: { inventory: [{ name: "стрела", qty: 2 }] },
    historical_evidence: [{ authority: "confirmed_event", turnNumber: 9, text: "В ход 10 герой безусловно получает ещё три оплаченные стрелы. Поставка не зависит от ворот." }],
    provisional_independent_additions: [{ type: "inventory.add", name: "стрела", qty: 3 }],
  } },
];

async function run() {
  const scenarios = process.argv.includes("--heldout") ? heldout : development;
  const fixtureHash = createHash("sha256").update(JSON.stringify(scenarios)).digest("hex");
  const all = selectNarrativeChecks({ action: "Проверка", narration: "", declaration: { mode: "event", referencesPast: false }, hasDice: true, hasStateChanges: true, hasProvisionalIndependentAdds: true, rejected: [] });
  const selection = process.argv.includes("--batch") ? all : { ...all, questions: { independent_acquisitions: all.questions.independent_acquisitions } };
  if (!process.argv.includes("--live")) { console.log(JSON.stringify({ fixtureHash, scenarios: scenarios.map(s => ({ id: s.id, expected: s.expected })) })); return; }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const rows = [];
  for (const scenario of scenarios) {
    let httpStatus: number | null = null;
    const result = await verifyNarrative({ provider: "openrouter", apiKey, timeoutMs: 5000, selection,
      state: { currentTurn: 10, before_state: { inventory: [] }, historical_evidence: [], accepted_changes: {}, draft: "", ...scenario.state },
      fetchImpl: async (url, init) => { const response = await fetch(url, init); httpStatus = response.status; return response; } });
    rows.push({ id: scenario.id, expected: scenario.expected, ...result, httpStatus });
    console.log(JSON.stringify({ id: scenario.id, expected: scenario.expected, status: result.status, answer: result.answers.independent_acquisitions }));
    if (result.status === "unavailable") break;
  }
  await mkdir("output/narrative-evaluation", { recursive: true });
  const output = `output/narrative-evaluation/independence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(output, JSON.stringify({ fixtureHash, question: selection.questions.independent_acquisitions, questionCount: Object.keys(selection.questions).length, syntheticOnly: true, scope: "synthetic predicate probe; not performTurn", rows }, null, 2));
  console.log(JSON.stringify({ output, calls: rows.length }));
}
run().catch(error => { console.error(error instanceof Error ? error.message : "evaluation_failed"); process.exitCode = 1; });
