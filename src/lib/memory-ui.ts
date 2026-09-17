// Чистые константы Memory House для клиента и сервера (без импорта БД).
import type { MemorySource } from "@/db/schema";

export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "chronicle";

export const LAYER_INFO: Record<MemoryLayer, { label: string; icon: string; hint: string; budget: number }> = {
  chronicle: { label: "Хроника глав", icon: "📜", hint: "Главные вехи и итоги пройденного пути", budget: 3500 },
  episodic: { label: "События", icon: "📖", hint: "Ключевые решения, встречи и последствия", budget: 5000 },
  semantic: { label: "Знания о мире", icon: "🧠", hint: "NPC, локации, предметы и факты", budget: 4000 },
  procedural: { label: "Правила", icon: "⚙️", hint: "Особенности героя и механики", budget: 2000 },
  working: { label: "Недавнее", icon: "⚡", hint: "Последние ходы (вставляются в промпт напрямую)", budget: 4000 },
};

export const SOURCE_INFO: Record<MemorySource, { label: string; icon: string; hint: string }> = {
  state: { label: "состояние", icon: "✅", hint: "Подтверждённое изменение игрового состояния" },
  "ai-semantic": { label: "AI-факт", icon: "🔎", hint: "Извлечено экстрактором из текста с цитатой-доказательством" },
  compaction: { label: "компакция", icon: "🗜️", hint: "Сжатие блока ходов старшей моделью" },
  seed: { label: "канон", icon: "🌱", hint: "Стартовый канон кампании" },
  heuristic: { label: "эвристика", icon: "⚠️", hint: "Устаревший keyword-путь (старые данные)" },
};
