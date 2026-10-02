/** NARR-12: size of each live-prompt component, measured where the turn prompt is assembled.
 * System/user sizes count UTF-16 code units, capped at MAX_CHARS. Section sizes measure
 * supplied fragments, not an exhaustive partition of the rendered prompt. Tokens use
 * the project's coarse estimate (chars / 3.6, the same rule as
 * `estimateTokens` in gemini.ts) and are not provider-reported usage. No prompt text is stored. */
export const PROMPT_BUDGET_SECTIONS = [
  "scenario", "entities", "memory", "retrieved", "recent", "life", "agenda", "social",
  "conditions", "narrator", "verification", "evidence", "action",
] as const;
export type PromptBudgetSection = (typeof PROMPT_BUDGET_SECTIONS)[number];
export type PromptBudget = {
  version: 1;
  systemChars: number;
  userChars: number;
  schemaChars: number;
  estimatedTokens: number;
  sections: Partial<Record<PromptBudgetSection, number>>;
};

export const PROMPT_SECTION_LABELS: Record<PromptBudgetSection, string> = {
  scenario: "Сценарий кампании",
  entities: "Сущности сцены: инвентарь, цели, NPC, объекты",
  memory: "Дайджест памяти",
  retrieved: "Найденные факты",
  recent: "Последние ходы",
  life: "Жизнь мира и намерение",
  agenda: "Повестка событий",
  social: "Люди мира и распорядок",
  conditions: "Состояния и способы снятия",
  narrator: "Голос рассказчика",
  verification: "Инструкция проверяемого рассказа",
  evidence: "Доказательства и договорённости",
  action: "Действие игрока",
};

const MAX_CHARS = 5_000_000;
const clamp = (value: number) => Math.max(0, Math.min(MAX_CHARS, Math.round(value)));
export const estimatePromptTokens = (chars: number) => (chars > 0 ? Math.max(1, Math.ceil(chars / 3.6)) : 0);

function size(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, item: unknown) => sum + size(item), 0);
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
}

export function measurePromptBudget(input: { system: string; user: string; schema?: unknown; sections: Partial<Record<PromptBudgetSection, unknown>> }): PromptBudget {
  const sections: Partial<Record<PromptBudgetSection, number>> = {};
  for (const key of PROMPT_BUDGET_SECTIONS) {
    const chars = clamp(size(input.sections[key]));
    if (chars > 0) sections[key] = chars;
  }
  const systemChars = clamp(input.system.length);
  const userChars = clamp(input.user.length);
  const schemaChars = clamp(input.schema === undefined ? 0 : size(input.schema));
  return {
    version: 1, systemChars, userChars, schemaChars,
    estimatedTokens: clamp(estimatePromptTokens(systemChars) + estimatePromptTokens(userChars) + estimatePromptTokens(schemaChars)),
    sections,
  };
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_CHARS ? value : null);

/** Bounded parse for stored budgets. Unknown sections are dropped; malformed rows are ignored. */
export function readPromptBudget(raw: unknown): PromptBudget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const systemChars = count(value.systemChars), userChars = count(value.userChars), schemaChars = count(value.schemaChars), estimatedTokens = count(value.estimatedTokens);
  if (value.version !== 1 || systemChars === null || userChars === null || schemaChars === null || estimatedTokens === null) return null;
  const sections: Partial<Record<PromptBudgetSection, number>> = {};
  const rawSections = value.sections && typeof value.sections === "object" && !Array.isArray(value.sections) ? value.sections as Record<string, unknown> : {};
  for (const key of PROMPT_BUDGET_SECTIONS) { const chars = count(rawSections[key]); if (chars !== null && chars > 0) sections[key] = chars; }
  return { version: 1, systemChars, userChars, schemaChars, estimatedTokens, sections };
}
