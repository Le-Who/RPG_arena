import { randomUUID } from "node:crypto";
import type { CheckpointSnapshot } from "../../src/lib/checkpoint-types";

export const source = "11111111-1111-4111-8111-111111111111";
export const now = "2026-09-23T08:00:00.000Z";
export function portableFixture(): CheckpointSnapshot {
  const location = randomUUID(), memory = randomUUID();
  return {
    schemaVersion: 1,
    session: {
      id: source, title: "Harbor", scenarioId: "custom", scenarioTitle: "A harbor",
      scenarioPrompt: "Trade and sail", campaignMode: "free", rulesProfile: "rules-light",
      character: { name: "Ada", archetype: "Trader", level: 1, xp: 0, hp: 10, maxHp: 10, gold: 5, stats: { Wits: 2 }, skills: ["Trade"], traits: ["Brave"], backstory: "Sailor", appearance: "Blue coat", conditions: ["Tired"] },
      worldState: { worldName: "Harbor", tone: "Hopeful", era: "Age of sail", mainQuest: "Trade", currentLocation: "Market", factions: ["Guild"], flags: { paid: true, marker: memory }, danger: 5, chapter: 1 },
      status: "active", turnCount: 1, contextTokensEstimate: 12, lastCompactTurn: 0,
    },
    turns: [{
      id: randomUUID(), sessionId: source, turnNumber: 1, role: "narrator", content: "The market opens.",
      choices: ["Trade"], dice: null, modelUsed: "preset-intro", taskType: "narration", promptTokens: 0,
      completionTokens: 5, requestId: null, stateChanges: null,
      contextMeta: { model: "preset-intro", rulesProfile: "rules-light", digestChars: 0, retrievedIds: [memory] },
      createdAt: now,
    }],
    inventory: [{ id: randomUUID(), sessionId: source, name: "Key", kind: "tool", description: "", quantity: 1, equipped: false, power: 0, icon: "K", createdAt: now }],
    locations: [{ id: location, sessionId: source, name: "Market", description: "", x: 1, y: 2, discovered: true, current: true, danger: 5, icon: "M", connectedTo: [location] }],
    quests: [{ id: randomUUID(), sessionId: source, key: "trade", title: "Trade", description: "", status: "active", progress: 0, isMain: true, updatedTurn: 1, createdAt: now }],
    npcs: [{ id: randomUUID(), sessionId: source, key: "merchant", name: "Merchant", role: "Trader", description: "", relation: 0, status: "alive", lastSeenTurn: 1, lastLocation: "Market", createdAt: now }],
    sceneObjects: [{ id: randomUUID(), sessionId: source, key: "door", name: "Door", locationName: "Market", state: "closed", description: "", interactable: true, updatedTurn: 1, createdAt: now }],
    memories: [{ id: memory, sessionId: source, layer: "semantic", category: "world", title: "Market", content: "A trading market", importance: 50, salience: 50, tokensEstimate: 10, parentId: null, turnFrom: 1, turnTo: 1, source: "state", sourceTurn: 1, contentHash: "old", entityKey: `location:${location}`, confidence: 1, evidence: null, createdAt: now, updatedAt: now }],
    links: [],
    agreements: [],
  };
}
