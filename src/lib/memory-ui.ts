// Чистые константы Memory House для клиента и сервера (без импорта БД).
export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "chronicle";

export const LAYER_INFO: Record<MemoryLayer, { label: string; icon: string; hint: string; budget: number }> = {
  chronicle: { label: "Хроника глав", icon: "📜", hint: "Главные вехи и итоги пройденного пути", budget: 3500 },
  episodic: { label: "События", icon: "📖", hint: "Ключевые решения, встречи и последствия", budget: 5000 },
  semantic: { label: "Знания о мире", icon: "🧠", hint: "NPC, локации, предметы и факты", budget: 4000 },
  procedural: { label: "Правила", icon: "⚙️", hint: "Особенности героя и механики", budget: 2000 },
  working: { label: "Недавнее", icon: "⚡", hint: "Последние ходы (вставляются в промпт напрямую)", budget: 4000 },
};
