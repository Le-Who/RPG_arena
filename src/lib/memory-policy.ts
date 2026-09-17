import type { MemorySource } from "@/db/schema";
export function mayReplaceMemory(current: { source: MemorySource; sourceTurn: number | null }, incoming: { source: MemorySource; sourceTurn: number }): boolean {
  if (current.sourceTurn !== null && incoming.sourceTurn < current.sourceTurn) return false;
  if ((incoming.source === "ai-semantic" || incoming.source === "compaction") && (current.source === "state" || current.source === "seed")) return false;
  return true;
}
