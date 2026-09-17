// ── Каталог моделей, квоты, роутинг задач, ротация ключей ──
// Квоты: flash 20 req/day на каждую модель (3.8, 3.7, 3.6), lite 500 req/day.
// Стратегия: lite берет на себя рутину и стандартные ходы нарратива (500 лимита!),
// а flash 3.8/3.7/3.6 сберегаются для сжатия памяти и сложных свободных действий.
// CONTEXT_BUDGET и TOTAL_CONTEXT_BUDGET определены в memory.ts.


export const MODEL_CATALOG = [
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    family: "lite" as const,
    tier: "fast-economy",
    dailyLimit: 500,
    role: "Обычный нарратив, стандартные ходы, извлечение фактов, инвентарь",
    badge: "500 запросов / день",
    strength: 80,
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    family: "flash" as const,
    tier: "flagship",
    dailyLimit: 20,
    role: "Сложные свободные действия игрока, Memory House компакция, босс-файты",
    badge: "20 запросов / день",
    strength: 100,
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    family: "flash" as const,
    tier: "fallback-1",
    dailyLimit: 20,
    role: "Фолбэк-1 для сложных задач и балансировки нагрузки",
    badge: "20 запросов / день",
    strength: 92,
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    family: "flash" as const,
    tier: "fallback-2",
    dailyLimit: 20,
    role: "Фолбэк-2 для сложных задач",
    badge: "20 запросов / день",
    strength: 85,
  },
] as const;

export type TaskType =
  | "narration" // стандартный ход по выбранному варианту 1/2/3
  | "resolution" // свободное действие игрока (free-form action)
  | "compaction" // сжатие памяти Memory House
  | "fast" // извлечение фактов / NPC / лута
  | "chapter_milestone"; // поворот сюжета / рубеж главы

export type RoutingProfile = "balanced" | "economy" | "flagship" | "custom";

export type RoutingConfig = {
  profile: RoutingProfile;
  narrationModel: string;
  customActionModel: string;
  compactionModel: string;
  fastTaskModel: string;
};

export const ROUTING_PROFILES: Record<RoutingProfile, { title: string; desc: string; config: Omit<RoutingConfig, "profile"> }> = {
  balanced: {
    title: "⚡ Баланс & Экономия (Рекомендуемый)",
    desc: "Lite 3.5 для нарратива и обычных ходов (до 500 ходов/день!). Flash 3.8 только для свободных действий и компакции памяти.",
    config: {
      narrationModel: "gemini-3.5-flash-lite",
      customActionModel: "gemini-3.8-flash",
      compactionModel: "gemini-3.8-flash",
      fastTaskModel: "gemini-3.5-flash-lite",
    },
  },
  economy: {
    title: "🌿 Максимальная Экономия",
    desc: "Lite 3.5 для всех видов ходов (обычных и свободных). Flash привлекается исключительно для сжатия памяти.",
    config: {
      narrationModel: "gemini-3.5-flash-lite",
      customActionModel: "gemini-3.5-flash-lite",
      compactionModel: "gemini-3.8-flash",
      fastTaskModel: "gemini-3.5-flash-lite",
    },
  },
  flagship: {
    title: "👑 Флагманский (Максимум деталей)",
    desc: "Flash 3.8 для всех операций. Самое богатое повествование, но расходует 20 запросов/день.",
    config: {
      narrationModel: "gemini-3.8-flash",
      customActionModel: "gemini-3.8-flash",
      compactionModel: "gemini-3.8-flash",
      fastTaskModel: "gemini-3.5-flash-lite",
    },
  },
  custom: {
    title: "⚙️ Кастомная настройка",
    desc: "Пользователь вручную назначает модель для каждой конкретной задачи.",
    config: {
      narrationModel: "gemini-3.5-flash-lite",
      customActionModel: "gemini-3.8-flash",
      compactionModel: "gemini-3.8-flash",
      fastTaskModel: "gemini-3.5-flash-lite",
    },
  },
};

/** Какая задача — какой пул моделей с учётом пользовательской конфигурации */
export function routeModelsFor(task: TaskType, config?: Partial<RoutingConfig>): string[] {
  const profile = config?.profile ?? "balanced";
  const defaults = ROUTING_PROFILES[profile]?.config ?? ROUTING_PROFILES.balanced.config;

  const narrationTarget = config?.narrationModel || defaults.narrationModel;
  const customTarget = config?.customActionModel || defaults.customActionModel;
  const compactionTarget = config?.compactionModel || defaults.compactionModel;
  const fastTarget = config?.fastTaskModel || defaults.fastTaskModel;

  if (task === "compaction") {
    // Компакция памяти требует старших моделей, lite как крайний фолбэк
    return [compactionTarget, "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"].filter(
      (m, i, arr) => arr.indexOf(m) === i,
    );
  }

  if (task === "resolution") {
    // Свободное действие игрока
    return [customTarget, "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"].filter(
      (m, i, arr) => arr.indexOf(m) === i,
    );
  }

  if (task === "fast") {
    // Быстрые задачи / извлечение фактов
    return [fastTarget, "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"].filter(
      (m, i, arr) => arr.indexOf(m) === i,
    );
  }

  // Обычный нарратив (выбор готового варианта 1/2/3)
  return [narrationTarget, "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"].filter(
    (m, i, arr) => arr.indexOf(m) === i,
  );
}

export function isLite(model: string) {
  return model.includes("lite");
}

/** Грубая оценка токенов: ~3.6 символа = 1 токен (RU/EN смесь). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.6));
}

// ── Промпты ───────────────────────────────────────────────
export function buildNarrationSystemPrompt(opts: {
  character: string;
  worldDigest: string;
  memoryDigest: string;
  recentTurns: string;
  location: string;
  tone: string; // тон/жанр мира — передаётся явно, чтобы не форсировать D&D-регистр
}): string {
  // Bookending: ключевые инструкции продублированы в начале и в конце промпта.
  // Это нейтрализует U-образный спад внимания ("lost in the middle") при расширенных контекстах.
  const header = `Ты — Гейм-мастер текстовой RPG (русский язык, второе лицо, кинематографично: 110–200 слов).
Тон и жанр истории: ${opts.tone}. Строго соблюдай атмосферу — не уходи в фэнтези, если мир современный; не уходи в бытовое, если мир эпический.
Персонаж: ${opts.character}
Мир и квест: ${opts.worldDigest}
Локация: ${opts.location}`;
  const memory = `ПАМЯТЬ КАНА (строго соблюдай факты, имена, предметы, HP и статусы): ${opts.memoryDigest}`;
  const recent = `Последние события: ${opts.recentTurns}`;
  // Повтор-заземление в хвосте (recency zone) — модель «видит» правила непосредственно перед генерацией
  const footer = `НАПОМИНАНИЕ — финальные правила:
· Тон: ${opts.tone}
· Персонаж: ${opts.character.slice(0, 120)}
· Локация: ${opts.location}
· Не противоречь канону памяти выше. Русский язык. Второе лицо.
· Обязательно заверши ответ вариантами в формате: ВАРИАНТЫ: 1) … | 2) … | 3) …`;
  return [header, memory, recent, footer].join("\n");
}

export function buildResolutionSystemPrompt(opts?: {
  tone?: string;
  worldName?: string;
  diceContext?: {
    skill: string;
    d20: number;
    modifier: number;
    total: number;
    dc: number;
    success: boolean;
    critical: string | null;
  };
}): string {
  const ctx = opts?.tone
    ? `Тон: ${opts.tone}. Мир: ${opts.worldName ?? "авторский"}.`
    : "";

  // Если передан результат предварительного броска — вставляем его как факт.
  // AI ОБЯЗАН писать нарратив под этот исход, не может его изменить.
  const diceBlock = opts?.diceContext
    ? (() => {
        const d = opts.diceContext!;
        const outcomeRu =
          d.critical === "crit"
            ? "КРИТИЧЕСКИЙ УСПЕХ (d20=20)"
            : d.critical === "fumble"
              ? "КРИТИЧЕСКАЯ НЕУДАЧА (d20=1)"
              : d.success
                ? `УСПЕХ (${d.total} ≥ DC ${d.dc})`
                : `НЕУДАЧА (${d.total} < DC ${d.dc})`;
        return `\nРЕЗУЛЬТАТ БРОСКА (факт, не меняй):\n· Навык: ${d.skill}\n· d20=${d.d20}${d.modifier >= 0 ? "+" : ""}${d.modifier} = ${d.total} vs DC ${d.dc}\n· Исход: ${outcomeRu}\n\nНарратив ОБЯЗАН соответствовать исходу выше. Если УСПЕХ — герой добивается цели (полностью или частично). Если НЕУДАЧА — цель не достигнута, возникают последствия. Не противоречь факту броска.`;
      })()
    : "";

  return `Ты — движок разрешения свободных действий (Action Resolution Engine). ${ctx}
Игрок совершает свободное авторское действие.${diceBlock}

Оцени реалистичность с учётом сеттинга, статов персонажа, инвентаря, сложности (DC) и памяти.

ВАЖНО о предметах:
· Игрок может взаимодействовать с ЛЮБЫМ объектом, который логично существует в сцене или мире.
· Предметы не ограничены заранее сгенерированным списком — если игрок подбирает камень, разбирает мышку, покупает семена, это всё валидно.
· Лут генерируй строго под сеттинг (современность → бытовые вещи; фэнтези → артефакты; sci-fi → техника).
· Если действие физически невозможно или нарушает канон — логично проваливай.

Верни СТРОГО валидный JSON:
{
  "outcome": "success" | "partial" | "failure",
  "dc": ${opts?.diceContext?.dc ?? 12},
  "roll_reason": "навык",
  "narration": "120-200 слов художественного описания последствий на русском во втором лице",
  "effects": {
    "hp": 0,
    "xp": 25,
    "gold": 0,
    "flags": {}
  },
  "loot": [
    { "name": "Название предмета", "kind": "misc", "description": "Краткое описание" }
  ],
  "choices": ["Вариант 1", "Вариант 2", "Вариант 3"]
}
Никакого текста вне JSON.`;
}

/** JSON Schema для structured output ответа resolution-задачи. */
export const RESOLUTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["success", "partial", "failure"] },
    dc: { type: "number" },
    roll_reason: { type: "string" },
    narration: { type: "string" },
    effects: {
      type: "object",
      properties: {
        hp: { type: "number" },
        xp: { type: "number" },
        gold: { type: "number" },
        flags: { type: "object" },
      },
      required: ["hp", "xp", "gold"],
    },
    loot: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "kind", "description"],
      },
    },
    choices: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["outcome", "narration", "effects", "choices"],
};

export function buildCompactionSystemPrompt(): string {
  return `Ты — модуль Memory House для текстовой RPG. Сожми блок ходов в структурированную память БЕЗ потери канона.
Верни СТРОГО валидный JSON без текста вне него:
{
  "episodic": [
    { "title": "...", "content": "Полное описание события с причиной и следствием", "importance": 0-100 }
  ],
  "semantic": [
    { "title": "...", "content": "Факт о персонаже, мире, NPC или предмете", "importance": 0-100 }
  ],
  "chronicle": "3-5 предложений: ключевые события главы, причинно-следственные связи, потери, обязательства, артефакты"
}
Правила важности (importance):
· ≥ 85: смерти, критические клятвы/долги, уникальные артефакты, потеря союзников
· ≥ 70: квесты, встречи с именными NPC, смена фракции, изменение HP > 20%
· ≥ 55: новые предметы, изученные локации, переговоры
· < 40: антураж и атмосфера — отбрасывается
Канон: не изменяй имена, не противоречь фактам уже существующей памяти (она передана в промпте).
НЕ дублируй факты, которые уже есть в существующей памяти — только новое и обновлённое.
Русский язык.`;
}

/**
 * @unused Зарезервировано для будущего lite-извлечения фактов через отдельный /fast эндпоинт.
 * В текущей версии извлечение ведётся эвристически через extractMemoryCandidates (memory.ts).
 */
export function buildFastSystemPrompt(): string {
  return `Ты — быстрый RPG-ассистент (lite). Извлеки факты из последнего хода в JSON: {"facts":[],"items":[],"npcs":[],"hp_delta":0,"gold_delta":0}. Без прозы.`;
}

// ── Вызов Gemini REST (v1beta) с ротацией ключей ──────────
export async function callGeminiWithRotation(opts: {
  keys: string[];
  models: string[];
  system: string;
  user: string;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  onAttempt?: (info: { model: string; keyIndex: number; ok: boolean; latencyMs: number; error?: string }) => Promise<void> | void;
}): Promise<{ text: string; model: string; keyIndex: number; latencyMs: number }> {
  const { keys, models, system, user } = opts;
  if (!keys.length) throw new Error("NO_KEYS");
  let lastErr = "unknown";
  for (const model of models) {
    for (let ki = 0; ki < keys.length; ki++) {
      const started = Date.now();
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(keys[ki])}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
              temperature: 0.85,
              maxOutputTokens: opts.maxTokens ?? 1200,
              ...(opts.responseSchema
                ? {
                    responseMimeType: "application/json",
                    responseSchema: opts.responseSchema,
                  }
                : {}),
            },
          }),
        });
        const latencyMs = Date.now() - started;
        if (!res.ok) {
          const t = await res.text();
          lastErr = `HTTP ${res.status}: ${t.slice(0, 300)}`;
          await opts.onAttempt?.({ model, keyIndex: ki, ok: false, latencyMs, error: lastErr });
          // 429 / quota limit — пробуем следующий ключ или модель в цепочке
          continue;
        }
        const data = await res.json();
        const text =
          data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
        if (!text) {
          lastErr = "EMPTY_RESPONSE";
          await opts.onAttempt?.({ model, keyIndex: ki, ok: false, latencyMs, error: lastErr });
          continue;
        }
        await opts.onAttempt?.({ model, keyIndex: ki, ok: true, latencyMs });
        return { text, model, keyIndex: ki, latencyMs };
      } catch (e) {
        const latencyMs = Date.now() - started;
        lastErr = e instanceof Error ? e.message : String(e);
        await opts.onAttempt?.({ model, keyIndex: ki, ok: false, latencyMs, error: lastErr });
      }
    }
  }
  throw new Error(`ALL_MODELS_FAILED: ${lastErr}`);
}
