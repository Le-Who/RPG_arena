import type { ReadingPreferences } from "@/db/schema";

export const DEFAULT_READING: ReadingPreferences = { textScale: "normal", measure: "normal", theme: "midnight", motion: "full" };

export const READING_OPTIONS = {
  textScale: [
    { value: "compact", label: "Компактный", hint: "Больше текста на экране" },
    { value: "normal", label: "Обычный", hint: "Рекомендуемый размер прозы" },
    { value: "large", label: "Крупный", hint: "Комфортно для долгого чтения" },
  ],
  measure: [
    { value: "narrow", label: "Узкая", hint: "≈54 знака в строке" },
    { value: "normal", label: "Обычная", hint: "≈64 знака — оптимум для чтения" },
    { value: "wide", label: "Широкая", hint: "≈76 знаков" },
  ],
  theme: [
    { value: "midnight", label: "Полночь", hint: "Тёмная фиолетовая палитра" },
    { value: "sepia", label: "Сепия", hint: "Тёплый приглушённый тон" },
    { value: "contrast", label: "Контраст", hint: "Максимальная различимость" },
  ],
  motion: [
    { value: "full", label: "Живые", hint: "Полные анимации интерфейса" },
    { value: "reduced", label: "Спокойные", hint: "Только мгновенные переходы" },
  ],
} as const satisfies Record<keyof ReadingPreferences, readonly { value: string; label: string; hint: string }[]>;

/** Strict allowlist: unknown or partial input can never produce an unrenderable theme. */
export function normalizeReading(value: unknown): ReadingPreferences {
  const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const pick = <K extends keyof ReadingPreferences>(key: K): ReadingPreferences[K] => {
    const allowed = READING_OPTIONS[key].map((option) => option.value) as readonly string[];
    const candidate = input[key];
    return (typeof candidate === "string" && allowed.includes(candidate) ? candidate : DEFAULT_READING[key]) as ReadingPreferences[K];
  };
  return { textScale: pick("textScale"), measure: pick("measure"), theme: pick("theme"), motion: pick("motion") };
}

/** Data attributes are the only contract between preferences and CSS. */
export function readingAttributes(reading: ReadingPreferences): Record<string, string> {
  return { "data-text": reading.textScale, "data-measure": reading.measure, "data-theme": reading.theme, "data-motion": reading.motion };
}
