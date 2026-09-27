/**
 * JEV-3a — единый типизированный слой заданий Jev (TypeSafe «systemone» / OpenRouter decisions).
 *
 * Контракт принадлежит серверу: модель отвечает только на закрытые вопросы с фиксированными
 * метками; она не меняет ресурсы, инвентарь, канон или SQL. Любой сбой транспорта, таймаут,
 * неполный ответ или низкая уверенность — отдельное состояние (`unavailable` / `insufficient`),
 * которое никогда не превращается молча в разрешение или отрицательный факт.
 *
 * Существующие потребители (проверка фактов памяти в `typesafe.ts` и проверка повествования в
 * `narrative-verifier.ts`) работают адаптерами над этим слоем и сохраняют прежние решения,
 * права, квоты и поведение при отказах.
 */

import { createHash } from "node:crypto";

export type JevProvider = "typesafe" | "openrouter";

export const JEV_PROVIDERS = {
  typesafe: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
  openrouter: { endpoint: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13" },
} as const;

/** Разрешённые модели по провайдеру; OpenRouter может добавлять датированные суффиксы. */
export function isAllowedJevModel(provider: JevProvider, model: unknown): model is string {
  if (typeof model !== "string") return false;
  return provider === "typesafe" ? model === JEV_PROVIDERS.typesafe.model : /^(?:typesafe\/)?jev-1\.13(?:\.0)?(?:-\d{4}-?\d{2}-?\d{2})?$/.test(model);
}

export type JevQuestion<Label extends string> = { type: "choice"; instructions: string; criteria: Record<Label, string> };

/** Политика неопределённости: какая метка означает «недостаточно», и какие пороги считаются уверенным ответом. */
export type JevUncertaintyPolicy<Label extends string> = {
  insufficientLabel: Label;
  minConfidence: number;
  minProbability: number;
};

export type JevTask<Label extends string> = {
  /** Стабильный идентификатор вида задания (например, `narrative-consistency`). */
  taskId: string;
  /** Версия формулировки/схемы вопросов; меняется при любом изменении текста инструкций. */
  taskVersion: string;
  labels: readonly Label[];
  /** Единая для всех вопросов политика; конкретные пороги калибруются по задаче, не по одному числу confidence. */
  uncertainty: JevUncertaintyPolicy<Label>;
  /** Только явно собранные данные; ключи, заголовки и конфигурация провайдера сюда не попадают. */
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion<Label>>;
  /** Метаданные снимка; актуальность и допустимые доказательства проверяет вызывающий серверный код. */
  snapshotVersion?: string | number;
  /** Требовать, чтобы вероятности всех меток суммировались в 1 (строгие потребители). */
  strictProbabilities?: boolean;
  /** Ограничения входа. */
  limits?: { maxQuestions?: number; maxBodyBytes?: number };
};

export type JevAnswer<Label extends string> = { choice: Label; confidence: number; probabilities: Record<Label, number> };

export type JevUsage = { inputTokens: number; outputTokens: number; cost?: number };

export type JevOutcomeStatus = "answered" | "skipped" | "unavailable";
export type JevUnavailableReason =
  | "missing_key" | "question_coverage" | "invalid_input" | "input_too_large"
  | "timeout" | "provider_error" | "invalid_response" | "request_failed" | "aborted";

export type JevOutcome<Label extends string> = {
  taskId: string;
  taskVersion: string;
  provider: JevProvider;
  model: string;
  status: JevOutcomeStatus;
  reason?: JevUnavailableReason | "not_required";
  answers: Record<string, JevAnswer<Label>>;
  usage?: JevUsage;
  latencyMs: number;
  snapshotVersion?: string | number;
};

/** Итог серверной политики для одного вопроса: доказательство, противоречие, неопределённость или отсутствие ответа. */
export type JevDecision = "accept" | "reject" | "insufficient" | "unavailable";

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isTokens = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export class JevResponseError extends Error {
  constructor() { super("invalid_response"); this.name = "JevResponseError"; }
}

/** Строгий разбор ответа провайдера. Любое отклонение от контракта — `invalid_response`, не «частичный успех». */
export function parseJevResponse<Label extends string>(raw: unknown, task: Pick<JevTask<Label>, "labels" | "questions" | "strictProbabilities">, provider: JevProvider): {
  model: string; answers: Record<string, JevAnswer<Label>>; usage: JevUsage;
} {
  if (!isRecord(raw) || !isAllowedJevModel(provider, raw.model) || !isRecord(raw.answers) || !isRecord(raw.usage)) throw new JevResponseError();
  const ids = Object.keys(task.questions);
  const answers: Record<string, JevAnswer<Label>> = Object.create(null);
  for (const id of ids) {
    if (!Object.hasOwn(raw.answers, id)) throw new JevResponseError();
    const a = raw.answers[id];
    if (!isRecord(a) || a.type !== "choice" || !task.labels.includes(a.choice as Label) || !isProbability(a.confidence) || !isRecord(a.probabilities)) throw new JevResponseError();
    const p = a.probabilities;
    if (!task.labels.every((label) => Object.hasOwn(p, label) && isProbability(p[label]))) throw new JevResponseError();
    const probabilities = Object.fromEntries(task.labels.map((label) => [label, p[label] as number])) as Record<Label, number>;
    if (task.strictProbabilities) {
      if (Object.keys(p).length !== task.labels.length) throw new JevResponseError();
      if (Math.abs(task.labels.reduce((s, label) => s + probabilities[label], 0) - 1) > 0.01) throw new JevResponseError();
      const choice = a.choice as Label;
      if (probabilities[choice] + 1e-6 < Math.max(...task.labels.map((label) => probabilities[label]))) throw new JevResponseError();
    }
    answers[id] = { choice: a.choice as Label, confidence: a.confidence, probabilities };
  }
  if (task.strictProbabilities && Object.keys(raw.answers).length !== ids.length) throw new JevResponseError();
  if (!isTokens(raw.usage.input_tokens) || !isTokens(raw.usage.output_tokens)) throw new JevResponseError();
  const cost = raw.usage.cost;
  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) throw new JevResponseError();
  return { model: raw.model, answers, usage: { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens, ...(typeof cost === "number" ? { cost } : {}) } };
}

/** Тело запроса — единый формат для обоих транспортов. Ключ не входит в тело. */
export function buildJevRequestBody<Label extends string>(task: JevTask<Label>, provider: JevProvider): Record<string, unknown> {
  return { model: JEV_PROVIDERS[provider].model, state: task.state, questions: task.questions };
}

export type JevTransport = (input: { taskId: string; taskVersion: string; provider: JevProvider; endpoint: string; body: string; apiKey: string; signal: AbortSignal }) => Promise<unknown>;

/** Транспорт по умолчанию: HTTPS без редиректов, HTTP-ошибка — `provider_error`. */
export function fetchJevTransport(fetchImpl: typeof fetch = fetch): JevTransport {
  return async ({ endpoint, body, apiKey, signal }) => {
    const res = await fetchImpl(endpoint, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body, signal });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new Error("provider_error"); }
    return res.json();
  };
}

export type JevRunOptions = {
  apiKey: string;
  provider?: JevProvider;
  timeoutMs?: number;
  /** Верхняя граница таймаута задания; сервер не ждёт дольше вне зависимости от вызывающего кода. */
  maxTimeoutMs?: number;
  signal?: AbortSignal;
  transport?: JevTransport;
  fetchImpl?: typeof fetch;
  /** Наблюдатель для учёта usage/латентности; не влияет на решение. */
  onUsage?: (event: { taskId: string; taskVersion: string; provider: JevProvider; model: string; usage: JevUsage; latencyMs: number }) => void | Promise<void>;
};

/** Выполняет задание. Никогда не бросает: любой сбой — `unavailable` с явной причиной. */
export async function runJevTask<Label extends string>(task: JevTask<Label>, options: JevRunOptions): Promise<JevOutcome<Label>> {
  const provider = options.provider ?? "typesafe";
  const config = JEV_PROVIDERS[provider];
  const base: JevOutcome<Label> = { taskId: task.taskId, taskVersion: task.taskVersion, provider, model: config.model, status: "unavailable", answers: {}, latencyMs: 0, ...(task.snapshotVersion !== undefined ? { snapshotVersion: task.snapshotVersion } : {}) };
  if (!options.apiKey.trim()) return { ...base, reason: "missing_key" };
  const ids = Object.keys(task.questions);
  const maxQuestions = task.limits?.maxQuestions ?? 12;
  if (!ids.length || ids.length > maxQuestions) return { ...base, reason: "question_coverage" };
  let body: string;
  try { body = JSON.stringify(buildJevRequestBody(task, provider)); }
  catch { return { ...base, reason: "invalid_input" }; }
  // Без тихого усечения: неизвестное покрытие — не проверенный результат.
  if (Buffer.byteLength(body, "utf8") > (task.limits?.maxBodyBytes ?? 100_000)) return { ...base, reason: "input_too_large" };
  if (options.signal?.aborted) return { ...base, reason: "aborted" };
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(options.maxTimeoutMs ?? 5000, options.timeoutMs ?? 2500));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const started = performance.now();
  try {
    // Гонка с сигналом отмены: транспорт, игнорирующий signal, всё равно не удерживает ход дольше таймаута.
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const raw = await Promise.race([
      (options.transport ?? fetchJevTransport(options.fetchImpl))({ taskId: task.taskId, taskVersion: task.taskVersion, provider, endpoint: config.endpoint, body, apiKey: options.apiKey.trim(), signal: controller.signal }),
      aborted,
    ]);
    const parsed = parseJevResponse(raw, task, provider);
    const latencyMs = Math.round(performance.now() - started);
    try { void Promise.resolve(options.onUsage?.({ taskId: task.taskId, taskVersion: task.taskVersion, provider, model: parsed.model, usage: parsed.usage, latencyMs })).catch(() => undefined); }
    catch { /* Observation must not replace a successfully parsed result. Usage stays in the outcome. */ }
    return { ...base, status: "answered", model: parsed.model, answers: parsed.answers, usage: parsed.usage, latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const reason: JevUnavailableReason = controller.signal.aborted
      ? (timedOut ? "timeout" : "aborted")
      : error instanceof JevResponseError ? "invalid_response"
      : error instanceof Error && error.message === "provider_error" ? "provider_error" : "request_failed";
    return { ...base, reason, latencyMs };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Серверная политика по одному ответу. `acceptLabel` — метка «подтверждено», `rejectLabel` — «противоречит».
 * Метка неопределённости, низкая уверенность или вероятность → `insufficient`; отсутствие ответа → `unavailable`.
 */
export function decideJevAnswer<Label extends string>(
  answer: JevAnswer<Label> | undefined,
  policy: JevUncertaintyPolicy<Label> & { acceptLabel: Label; rejectLabel?: Label },
): JevDecision {
  if (!answer) return "unavailable";
  const confident = answer.confidence >= policy.minConfidence && answer.probabilities[answer.choice] >= policy.minProbability;
  if (answer.choice === policy.insufficientLabel || !confident) return "insufficient";
  if (answer.choice === policy.acceptLabel) return "accept";
  if (policy.rejectLabel !== undefined && answer.choice === policy.rejectLabel) return "reject";
  return "insufficient";
}

/** Сводка по всем вопросам задания: хотя бы одно уверенное противоречие → reject; все подтверждены → accept. */
export function summarizeJevOutcome<Label extends string>(
  outcome: JevOutcome<Label>,
  policy: JevUncertaintyPolicy<Label> & { acceptLabel: Label; rejectLabel?: Label },
): JevDecision {
  if (outcome.status !== "answered") return "unavailable";
  const decisions = Object.values(outcome.answers).map((answer) => decideJevAnswer(answer, policy));
  if (!decisions.length) return "unavailable";
  if (decisions.includes("reject")) return "reject";
  if (decisions.every((d) => d === "accept")) return "accept";
  return "insufficient";
}

// ─────────────────────────────────────────────────────────────
//  Replay: записанные запросы/ответы для воспроизводимых проверок без сети
// ─────────────────────────────────────────────────────────────

export type JevRecording = { taskId: string; taskVersion: string; provider: JevProvider; bodySha256?: string; response: unknown };

/** Транспорт, отвечающий записанными ответами по порядку; лишние вызовы — `provider_error`. */
export function replayJevTransport(recordings: readonly JevRecording[]): JevTransport & { calls: { provider: JevProvider; body: string }[] } {
  const queue = structuredClone([...recordings]);
  const calls: { provider: JevProvider; body: string }[] = [];
  const transport: JevTransport = async ({ taskId, taskVersion, provider, body }) => {
    calls.push({ provider, body });
    const next = queue.shift();
    if (!next || next.provider !== provider || next.taskId !== taskId || next.taskVersion !== taskVersion
      || (next.bodySha256 !== undefined && next.bodySha256 !== createHash("sha256").update(body).digest("hex"))) throw new Error("provider_error");
    return structuredClone(next.response);
  };
  return Object.assign(transport, { calls });
}

/** Транспорт-регистратор: оборачивает реальный транспорт и сохраняет ответы для последующего replay. */
export function recordingJevTransport(inner: JevTransport, sink: JevRecording[], meta: { taskId: string; taskVersion: string }): JevTransport {
  return async (input) => {
    if (meta.taskId !== input.taskId || meta.taskVersion !== input.taskVersion) throw new Error("invalid_input");
    const response = await inner(input);
    sink.push({ ...meta, provider: input.provider, bodySha256: createHash("sha256").update(input.body).digest("hex"), response: structuredClone(response) });
    return response;
  };
}
