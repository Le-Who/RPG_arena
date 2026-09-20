import type { ExtractedFact } from "./memory";
import type { TypeSafeEvaluation, TypeSafeReport, TypeSafeVerdict } from "./typesafe-report";

export const TYPE_SAFE_MODEL = "jev-1.13.0" as const;
export const TYPE_SAFE_PROMPT_VERSION = "fact-verification-v1" as const;
export const TYPE_SAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const VERDICTS = ["supports", "contradicts", "unsupported"] as const;
const CRITERIA: Record<TypeSafeVerdict, string> = {
  supports: "Повествование прямо подтверждает факт или однозначно из него следует.",
  contradicts: "Повествование прямо опровергает факт или сообщает несовместимое событие.",
  unsupported: "Доказательств недостаточно: это намерение, гипотеза, двусмысленность или отсутствующая информация.",
};

export type TypeSafeRequest = {
  model: typeof TYPE_SAFE_MODEL;
  state: {
    narrator_text: string;
    player_action: { text: string; role: string };
    extracted_facts: { id: string; fact: string; evidence: string }[];
  };
  questions: Record<string, { type: "choice"; instructions: string; criteria: typeof CRITERIA }>;
};

export function buildTypeSafeRequest(input: { facts: ExtractedFact[]; narration: string; playerAction: string }): TypeSafeRequest {
  const facts = input.facts.slice(0, 6);
  const questions: TypeSafeRequest["questions"] = {};
  for (let index = 0; index < facts.length; index++) {
    questions[`fact${index}`] = {
      type: "choice",
      instructions: `Сопоставьте extracted_facts[${index}].fact и extracted_facts[${index}].evidence только с narrator_text. Выберите, подтверждает ли повествование этот факт. player_action — лишь намерение и не является доказательством.`,
      criteria: CRITERIA,
    };
  }
  return {
    model: TYPE_SAFE_MODEL,
    state: {
      narrator_text: input.narration,
      player_action: { text: input.playerAction, role: "Намерение игрока; не считать доказательством совершившегося события." },
      extracted_facts: facts.map((item, index) => ({ id: `fact${index}`, fact: item.content, evidence: item.evidence })),
    },
    questions,
  };
}

function invalid(): never {
  throw new Error("Некорректный ответ TypeSafe.");
}

function boundedNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid();
  return value;
}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

export function parseTypeSafeResponse(raw: unknown, facts: Pick<ExtractedFact, "content" | "evidence">[]): {
  model: typeof TYPE_SAFE_MODEL;
  evaluations: TypeSafeEvaluation[];
  usage: { inputTokens: number; outputTokens: number };
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const response = raw as Record<string, unknown>;
  if (response.model !== TYPE_SAFE_MODEL || !response.answers || typeof response.answers !== "object" || Array.isArray(response.answers)) invalid();
  if (!response.usage || typeof response.usage !== "object" || Array.isArray(response.usage)) invalid();
  const answers = response.answers as Record<string, unknown>;
  const evaluations: TypeSafeEvaluation[] = [];
  for (let index = 0; index < facts.length; index++) {
    const answer = answers[`fact${index}`];
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) invalid();
    const value = answer as Record<string, unknown>;
    if (value.type !== "choice" || !VERDICTS.includes(value.choice as TypeSafeVerdict) || !value.probabilities || typeof value.probabilities !== "object" || Array.isArray(value.probabilities)) invalid();
    const probabilities = value.probabilities as Record<string, unknown>;
    evaluations.push({
      factIndex: index,
      fact: facts[index].content,
      evidence: facts[index].evidence,
      choice: value.choice as TypeSafeVerdict,
      probabilities: {
        supports: boundedNumber(probabilities.supports),
        contradicts: boundedNumber(probabilities.contradicts),
        unsupported: boundedNumber(probabilities.unsupported),
      },
      confidence: boundedNumber(value.confidence),
    });
  }
  const usage = response.usage as Record<string, unknown>;
  return {
    model: TYPE_SAFE_MODEL,
    evaluations,
    usage: { inputTokens: tokenCount(usage.input_tokens), outputTokens: tokenCount(usage.output_tokens) },
  };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function verifyTypeSafeFacts(input: {
  enabled: boolean;
  apiKey: string;
  facts: ExtractedFact[];
  narration: string;
  playerAction: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<TypeSafeReport> {
  const base: Omit<TypeSafeReport, "status"> = { model: TYPE_SAFE_MODEL, promptVersion: TYPE_SAFE_PROMPT_VERSION, evaluations: [], usage: null, latencyMs: 0 };
  if (!input.enabled) return { ...base, status: "disabled" };
  if (!input.apiKey.trim()) return { ...base, status: "no_key" };
  if (!input.facts.length) return { ...base, status: "empty" };

  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5000);
  try {
    const response = await (input.fetchImpl ?? fetch)(TYPE_SAFE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildTypeSafeRequest(input)),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`TypeSafe вернул HTTP ${response.status}.`);
    }
    const parsed = parseTypeSafeResponse(await response.json(), input.facts.slice(0, 6));
    return { status: "ok", model: parsed.model, promptVersion: TYPE_SAFE_PROMPT_VERSION, evaluations: parsed.evaluations, usage: parsed.usage, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    const timedOut = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
    return { ...base, status: "error", latencyMs: Math.round(performance.now() - started), error: timedOut ? "TypeSafe не ответил за 5 секунд." : error instanceof Error && /^TypeSafe вернул HTTP \d+\.$/.test(error.message) ? error.message : "Не удалось проверить факты через TypeSafe." };
  } finally {
    clearTimeout(timer);
  }
}
