import type { ReadingPreferences, gameSessions, gameTurns, memoryNodes, inventoryItems, worldLocations, quests, npcs, sceneObjects } from "@/db/schema";
import { SCENARIOS } from "./scenarios";
export type Session = Omit<typeof gameSessions.$inferSelect, "scenarioPrompt">;
export type Snapshot = { isOwner?: boolean; session: Session; turns: (typeof gameTurns.$inferSelect)[]; memories: (typeof memoryNodes.$inferSelect)[]; inventory: (typeof inventoryItems.$inferSelect)[]; locations: (typeof worldLocations.$inferSelect)[]; quests: (typeof quests.$inferSelect)[]; npcs: (typeof npcs.$inferSelect)[]; sceneObjects: (typeof sceneObjects.$inferSelect)[]; embeddings: { nodes: number; ready: number; pending: number; processing: number; failed: number } | null };
export type Settings = { keysMasked: string[]; keysCount: number; envKeysCount: number; useLiveAI: boolean; routingProfile: string; narrationModel: string; customActionModel: string; compactionModel: string; fastTaskModel: string; dailyFlashLimit: number; dailyLiteLimit: number; enforceLimits: boolean; embeddingsEnabled: boolean; embeddingModel: string; embeddingDims: number; semanticExtractionEnabled: boolean };
export type Workspace = { id?: string; displayName: string; favorites: string[]; reading: ReadingPreferences };
export const PROFILE_LABELS: Record<string, string> = { d20: "D20", "rules-light": "Лёгкие правила", narrative: "Нарратив" };
export const PROFILE_DESCRIPTIONS: Record<string, string> = { d20: "Характеристики, ресурсы и серверные броски кубика.", "rules-light": "Минимум чисел. Проверка риска на 2d6 и успех с ценой.", narrative: "История без кубиков. Только выбор, канон и последствия." };
export const ART: Record<string, { image: string; category: string; color: string }> = {
  "ashen-crown": { image: "/chronicle-hero.webp", category: "Фэнтези", color: "violet" },
  "neon-pact": { image: "/neon-city.webp", category: "Киберпанк", color: "pink" },
  "drowned-speaker": { image: "/haunted-manor.webp", category: "Хоррор", color: "teal" },
  "echo-station": { image: "/space-odyssey.webp", category: "Sci-fi", color: "blue" },
  "clockwork-trial": { image: "/clockwork-city.webp", category: "Детектив", color: "amber" },
  "last-departure": { image: "/night-train.webp", category: "Детектив", color: "blue" },
  "star-herbarium": { image: "/star-garden.webp", category: "Фэнтези", color: "teal" },
  "sand-oracle": { image: "/sand-oracle.webp", category: "Фэнтези", color: "amber" },
};
export const WORLDS = Object.keys(ART).map((id) => SCENARIOS.find((s) => s.id === id)!).filter(Boolean);
export const coverFor = (id: string) => ART[id]?.image ?? "/space-odyssey.webp";
export const SOURCE_LABELS: Record<string, string> = { seed: "Канон мира", state: "Подтверждено сервером", "ai-semantic": "Извлечено AI", compaction: "Хроника", heuristic: "Архивный факт" };
