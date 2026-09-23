import type { AttemptInfo } from "./gemini";

export const STORY_TEXT_FIELDS = [
  "title",
  "worldName",
  "pitch",
  "era",
  "tone",
  "mainQuest",
  "startLocation",
  "name",
  "archetype",
  "backstory",
  "skills",
  "startItems",
] as const;

export type StoryTextField = (typeof STORY_TEXT_FIELDS)[number];
export type StoryDraft = Record<StoryTextField, string> & {
  rulesProfile: "narrative" | "rules-light" | "d20";
};
export type StoryDraftPatch = Partial<Record<StoryTextField, string>>;

const FIELD_LIMITS: Record<Exclude<StoryTextField, "skills" | "startItems">, number> = {
  title: 80,
  worldName: 80,
  pitch: 2000,
  era: 80,
  tone: 80,
  mainQuest: 500,
  startLocation: 80,
  name: 40,
  archetype: 40,
  backstory: 800,
};

const FIELD_LABELS: Record<StoryTextField, string> = {
  title: "Название истории",
  worldName: "Мир или место",
  pitch: "Завязка истории",
  era: "Эпоха",
  tone: "Тон повествования",
  mainQuest: "Цель героя",
  startLocation: "Стартовая локация",
  name: "Имя героя",
  archetype: "Роль",
  backstory: "Предыстория",
  skills: "Навыки",
  startItems: "Вещи с собой",
};

export class StoryDraftError extends Error {
  constructor(
    public code: "INVALID_INPUT" | "AI_REQUIRED" | "AI_FAILED",
    message: string,
    public status = code === "INVALID_INPUT" ? 400 : code === "AI_REQUIRED" ? 409 : 502,
  ) {
    super(message);
    this.name = "StoryDraftError";
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoryDraftError("INVALID_INPUT", "draft должен быть объектом.");
  }
  return value as Record<string, unknown>;
}

function validateFlatList(value: string, label: string, totalMax: number, itemMax: number) {
  if (value.length > totalMax) throw new StoryDraftError("INVALID_INPUT", `${label}: максимум ${totalMax} символов.`);
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length > 6) throw new StoryDraftError("INVALID_INPUT", `${label}: укажите не больше 6 пунктов.`);
  if (items.some((item) => item.length > itemMax)) throw new StoryDraftError("INVALID_INPUT", `${label}: один пункт длиннее ${itemMax} символов.`);
}

/** Creation errors are shown on the original control; never silently truncate input. */
export function storyDraftCreationError(field: StoryTextField, value: string): string {
  if ((field === "title" || field === "name") && !value.trim()) return "Заполните это поле.";
  if (field === "pitch" && value.trim().length < 15) return "Опишите завязку хотя бы в 15 символах.";
  try {
    if (field === "skills") validateFlatList(value, FIELD_LABELS[field], 240, 40);
    else if (field === "startItems") validateFlatList(value, FIELD_LABELS[field], 360, 60);
    else if (value.length > FIELD_LIMITS[field]) return `Максимум ${FIELD_LIMITS[field]} символов.`;
  } catch (error) { return error instanceof Error ? error.message : "Проверьте поле."; }
  return "";
}

/** Validate without trimming so user-authored bytes remain untouched. */
export function validateStoryDraft(value: unknown): StoryDraft {
  const record = objectValue(value);
  const out = {} as StoryDraft;
  for (const field of STORY_TEXT_FIELDS) {
    const item = record[field];
    if (typeof item !== "string") throw new StoryDraftError("INVALID_INPUT", `${FIELD_LABELS[field]} должно быть строкой.`);
    if (field === "skills") validateFlatList(item, FIELD_LABELS[field], 240, 40);
    else if (field === "startItems") validateFlatList(item, FIELD_LABELS[field], 360, 60);
    else if (item.length > FIELD_LIMITS[field]) throw new StoryDraftError("INVALID_INPUT", `${FIELD_LABELS[field]}: превышен лимит ${FIELD_LIMITS[field]} символов.`);
    if (field === "pitch" && item.trim() && item.trim().length < 15) throw new StoryDraftError("INVALID_INPUT", "Завязка истории должна быть не короче 15 символов.");
    out[field] = item;
  }
  if (record.rulesProfile !== "narrative" && record.rulesProfile !== "rules-light" && record.rulesProfile !== "d20") {
    throw new StoryDraftError("INVALID_INPUT", "Неизвестный профиль правил.");
  }
  out.rulesProfile = record.rulesProfile;
  return out;
}

export function canApplyStoryDraftPatch(input: {
  requested: StoryDraft;
  current: StoryDraft;
  requestedMode: "preset" | "free";
  currentMode: "preset" | "free";
  requestId: number;
  currentRequestId: number;
}): boolean {
  return input.requestedMode === "free"
    && input.currentMode === "free"
    && input.requestId === input.currentRequestId
    && STORY_TEXT_FIELDS.every((field) => input.requested[field] === input.current[field])
    && input.requested.rulesProfile === input.current.rulesProfile;
}

export function evaluateStoryDraftPatch(draft: StoryDraft, patch: StoryDraftPatch): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const field of STORY_TEXT_FIELDS) {
    if (draft[field].trim() !== "" && field in patch) issues.push(`перезаписано заполненное поле ${field}`);
  }
  const merged = { ...draft, ...patch };
  for (const field of STORY_TEXT_FIELDS) {
    if (draft[field].trim() === "" && merged[field].trim() === "") issues.push(`не заполнено поле ${field}`);
  }
  try {
    validateStoryDraft(merged);
  } catch (error) {
    issues.push(error instanceof Error ? `невалидный результат: ${error.message}` : "невалидный результат");
  }
  return { passed: issues.length === 0, issues };
}

type GeneratedDraft = Omit<Record<StoryTextField, string>, "skills" | "startItems"> & {
  skills: string[];
  startItems: string[];
};

function normalizeGeneratedList(value: unknown, label: string, totalMax: number, itemMax: number): string {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6 || value.some((item) => typeof item !== "string" || item.trim().length < 1 || item.trim().length > itemMax)) {
    throw new Error(`${label}: ожидается от 1 до 6 строк, каждая не длиннее ${itemMax} символов`);
  }
  const joined = value.map((item) => (item as string).trim()).join(", ");
  validateFlatList(joined, label, totalMax, itemMax);
  return joined;
}

function generatedField(value: unknown, field: Exclude<StoryTextField, "skills" | "startItems">): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > FIELD_LIMITS[field]) {
    throw new Error(`${FIELD_LABELS[field]}: ожидается непустая строка до ${FIELD_LIMITS[field]} символов`);
  }
  if (field === "pitch" && value.trim().length < 15) throw new Error("Завязка истории должна быть не короче 15 символов");
  return value;
}

export function filterStoryDraftPatch(draft: StoryDraft, candidate: Record<string, unknown>): StoryDraftPatch {
  const patch: StoryDraftPatch = {};
  for (const field of STORY_TEXT_FIELDS) {
    if (draft[field].trim() !== "") continue;
    if (field === "skills") patch.skills = normalizeGeneratedList(candidate.skills, FIELD_LABELS.skills, 240, 40);
    else if (field === "startItems") patch.startItems = normalizeGeneratedList(candidate.startItems, FIELD_LABELS.startItems, 360, 60);
    else patch[field] = generatedField(candidate[field], field);
  }
  return patch;
}

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    worldName: { type: "string" },
    pitch: { type: "string" },
    era: { type: "string" },
    tone: { type: "string" },
    mainQuest: { type: "string" },
    startLocation: { type: "string" },
    name: { type: "string" },
    archetype: { type: "string" },
    backstory: { type: "string" },
    skills: { type: "array", items: { type: "string" } },
    startItems: { type: "array", items: { type: "string" } },
  },
  required: [...STORY_TEXT_FIELDS],
};

export type StoryDraftGenerationCall = {
  beforeAttempt?: (model: string) => Promise<boolean>;
  keys: string[];
  models: string[];
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  responseSchema: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  onAttempt: (info: AttemptInfo) => Promise<void>;
};

type GenerationResult = {
  text: string;
  model: string;
  keyIndex: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
};

export type StoryDraftLog = {
  sessionId: null;
  model: string;
  taskType: "creation";
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  keyIndex: number;
};

type StoryDraftAIConfig = { keys: string[]; canUseLive: boolean };

export type StoryDraftServiceDeps<TConfig extends StoryDraftAIConfig = StoryDraftAIConfig> = {
  loadConfig: () => Promise<TConfig>;
  selectModels: (config: TConfig) => Promise<string[]>;
  beforeAttempt?: (config: TConfig, model: string) => Promise<boolean>;
  generate: (call: StoryDraftGenerationCall) => Promise<GenerationResult>;
  log: (row: StoryDraftLog) => Promise<void>;
  now?: () => number;
};

function promptFor(draft: StoryDraft, missing: StoryTextField[]): { system: string; user: string } {
  return {
    system: `Ты помогаешь подготовить черновик русскоязычной интерактивной истории. Заполни все поля согласованно и конкретно. Не меняй заданные пользователем ограничения. Не добавляй rulesProfile. Навыки и вещи верни массивами: не больше 6 коротких пунктов. Ответ — только JSON по схеме. Пустые поля: ${missing.join(", ")}.`,
    user: JSON.stringify(draft),
  };
}

function parsePatch(text: string, draft: StoryDraft): StoryDraftPatch {
  const parsed = JSON.parse(text) as unknown;
  return filterStoryDraftPatch(draft, objectValue(parsed));
}

async function logSuccessfulGeneration(deps: Pick<StoryDraftServiceDeps, "log">, response: GenerationResult) {
  await deps.log({
    sessionId: null,
    model: response.model,
    taskType: "creation",
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
    latencyMs: response.latencyMs,
    success: true,
    keyIndex: response.keyIndex,
  });
}

export function createStoryDraftAutofillService<TConfig extends StoryDraftAIConfig>(deps: StoryDraftServiceDeps<TConfig>) {
  return async (rawDraft: unknown, signal?: AbortSignal): Promise<{ patch: StoryDraftPatch; modelUsed: string }> => {
    const now = deps.now ?? Date.now;
    const deadline = now() + 30_000;
    signal?.throwIfAborted();
    const draft = validateStoryDraft(rawDraft);
    const missing = STORY_TEXT_FIELDS.filter((field) => draft[field].trim() === "");
    if (!missing.length) return { patch: {}, modelUsed: "none" };

    const config = await deps.loadConfig();
    signal?.throwIfAborted();
    if (!config.keys.length || !config.canUseLive) {
      throw new StoryDraftError("AI_REQUIRED", "Для автозаполнения подключите и включите Gemini в настройках.");
    }
    const basePrompt = promptFor(draft, missing);
    let system = basePrompt.system;
    let user = basePrompt.user;
    let lastValidationError = "";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      if (deadline - now() <= 0) throw new StoryDraftError("AI_FAILED", "Gemini не успел заполнить черновик за 30 секунд.", 504);
      const selected = await deps.selectModels(config);
      signal?.throwIfAborted();
      const models = selected.filter((model) => model === "gemini-3.5-flash-lite");
      if (!models.length) throw new StoryDraftError("AI_FAILED", "Лимит Gemini 3.5 Flash Lite на сегодня исчерпан.", 429);
      const remaining = deadline - now();
      if (remaining <= 0) throw new StoryDraftError("AI_FAILED", "Gemini не успел заполнить черновик за 30 секунд.", 504);
      let response: GenerationResult;
      try {
        response = await deps.generate({
          beforeAttempt: deps.beforeAttempt ? model => deps.beforeAttempt!(config, model) : undefined,
          keys: config.keys,
          models,
          system,
          user,
          maxTokens: 1800,
          temperature: attempt === 0 ? 0.8 : 0.2,
          responseSchema: RESPONSE_SCHEMA,
          timeoutMs: remaining,
          signal,
          onAttempt: async (info) => {
            if (info.ok) return;
            await deps.log({ sessionId: null, model: info.model, taskType: "creation", promptTokens: 0, completionTokens: 0, latencyMs: info.latencyMs, success: false, error: info.error, keyIndex: info.keyIndex });
          },
        });
      } catch (error) {
        const timedOut = error instanceof Error && /timeout|deadline|abort/i.test(`${error.name} ${error.message}`);
        throw new StoryDraftError("AI_FAILED", timedOut ? "Gemini не ответил за 30 секунд." : "Gemini сейчас недоступен. Попробуйте ещё раз.", timedOut ? 504 : 502);
      }
      await logSuccessfulGeneration(deps, response);
      try {
        return { patch: parsePatch(response.text, draft), modelUsed: response.model };
      } catch (error) {
        lastValidationError = error instanceof Error ? error.message : String(error);
        if (attempt === 1) break;
        system = `${basePrompt.system}\n\nИсправь предыдущий невалидный ответ. Верни полный объект, строго по схеме, без Markdown.`;
        user = `Черновик пользователя:\n${basePrompt.user}\n\nНевалидный ответ:\n${response.text}\n\nОшибка проверки: ${lastValidationError}`;
      }
    }
    throw new StoryDraftError("AI_FAILED", `Gemini дважды вернул невалидный ответ: ${lastValidationError.slice(0, 160)}`);
  };
}

export const STORY_DRAFT_RESPONSE_SCHEMA = RESPONSE_SCHEMA;
export type { GeneratedDraft };
