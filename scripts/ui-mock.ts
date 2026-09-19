import type { Page } from "@playwright/test";

export const mockSessionId = "00000000-0000-4000-8000-000000000001";
const now = "2026-09-19T12:00:00.000Z";

export const mockSession = {
  id: mockSessionId,
  title: "Пепельная корона",
  scenarioId: "ashen-crown",
  scenarioTitle: "Пепельная корона",
  branchOrigin: null,
  campaignMode: "preset",
  rulesProfile: "d20",
  character: {
    name: "Элиан", archetype: "Следопыт", level: 2, xp: 180, hp: 18, maxHp: 24, gold: 36,
    stats: { СИЛ: 11, ЛОВ: 16, ВЫН: 13, ИНТ: 12, МУД: 15, ХАР: 10 },
    skills: ["Выживание", "Наблюдательность"], traits: ["Верность слову"],
    backstory: "Бывший королевский разведчик ищет правду о падении столицы.", appearance: "Серый плащ и медная застёжка.", conditions: [],
  },
  worldState: {
    worldName: "Королевство Эшмор", tone: "Тёмное героическое фэнтези", era: "После Пепельной войны",
    mainQuest: "Вернуть утраченную корону", currentLocation: "Тихая гавань", factions: ["Хранители", "Пепельный двор"],
    flags: { metKeeper: true }, danger: 34, chapter: 2,
  },
  status: "active", turnCount: 3, contextTokensEstimate: 1420, lastCompactTurn: 0, createdAt: now, updatedAt: now,
};

const locations = [
  { id: "10000000-0000-4000-8000-000000000001", sessionId: mockSessionId, name: "Тихая гавань", description: "Укрытый туманом порт.", icon: "⚓", x: 10, y: 58, danger: 18, discovered: true, current: true, connectedTo: ["10000000-0000-4000-8000-000000000002"], createdAt: now },
  { id: "10000000-0000-4000-8000-000000000002", sessionId: mockSessionId, name: "Пепельный тракт", description: "Старая дорога к столице.", icon: "🛤️", x: 45, y: 36, danger: 41, discovered: true, current: false, connectedTo: ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000003"], createdAt: now },
  { id: "10000000-0000-4000-8000-000000000003", sessionId: mockSessionId, name: "Башня воронов", description: "Разрушенная сторожевая башня.", icon: "🏰", x: 82, y: 18, danger: 73, discovered: true, current: false, connectedTo: ["10000000-0000-4000-8000-000000000002"], createdAt: now },
];

export const mockSnapshot = {
  session: mockSession,
  turns: [
    { id: "20000000-0000-4000-8000-000000000001", sessionId: mockSessionId, turnNumber: 1, role: "narrator", content: "Над Тихой гаванью стелется серебряный туман. На причале вас ждёт посланник Хранителей.", choices: ["Поговорить с посланником", "Осмотреть следы у воды", "Подняться к старому маяку"], dice: null, modelUsed: "preset-intro", taskType: "narration", stateChanges: null, promptTokens: 0, completionTokens: 0, requestId: null, contextMeta: null, createdAt: now },
    { id: "20000000-0000-4000-8000-000000000002", sessionId: mockSessionId, turnNumber: 2, role: "player", content: "Я изучаю печать на письме и спрашиваю посланника о дороге.", choices: [], dice: null, modelUsed: "offline-engine", taskType: "resolution", stateChanges: null, promptTokens: 0, completionTokens: 0, requestId: "audit-turn", contextMeta: null, createdAt: now },
    { id: "20000000-0000-4000-8000-000000000003", sessionId: mockSessionId, turnNumber: 3, role: "narrator", content: "Печать настоящая. Посланник отмечает на карте безопасный путь, но предупреждает о дозорах у Башни воронов.", choices: ["Выйти на Пепельный тракт", "Расспросить о дозорах", "Подготовить снаряжение"], dice: { d20: 14, modifier: 3, total: 17, dc: 13, success: true, critical: null, skill: "Анализ", label: "Проверка печати", kind: "d20" }, modelUsed: "offline-engine", taskType: "narration", stateChanges: null, promptTokens: 0, completionTokens: 0, requestId: null, contextMeta: null, createdAt: now },
  ],
  memories: [
    { id: "30000000-0000-4000-8000-000000000001", sessionId: mockSessionId, layer: "semantic", category: "world", title: "Печать Хранителей", content: "Послание подтверждено настоящей печатью.", importance: 76, salience: 70, tokensEstimate: 12, parentId: null, turnFrom: 2, turnTo: 3, source: "state", sourceTurn: 3, contentHash: "audit", entityKey: "seal", confidence: 1, evidence: "Печать настоящая", createdAt: now, updatedAt: now },
    { id: "30000000-0000-4000-8000-000000000002", sessionId: mockSessionId, layer: "episodic", category: "location", title: "Дорога к башне", content: "У Башни воронов замечены дозоры.", importance: 64, salience: 62, tokensEstimate: 10, parentId: null, turnFrom: 3, turnTo: 3, source: "seed", sourceTurn: 3, contentHash: "audit2", entityKey: "tower", confidence: 1, evidence: null, createdAt: now, updatedAt: now },
  ],
  inventory: [
    { id: "40000000-0000-4000-8000-000000000001", sessionId: mockSessionId, name: "Карта побережья", description: "На полях отмечены старые тропы.", quantity: 1, equipped: false, icon: "🗺️", properties: {}, createdAt: now },
    { id: "40000000-0000-4000-8000-000000000002", sessionId: mockSessionId, name: "Короткий лук", description: "Надёжное оружие разведчика.", quantity: 1, equipped: true, icon: "🏹", properties: {}, createdAt: now },
  ],
  locations,
  quests: [{ id: "50000000-0000-4000-8000-000000000001", sessionId: mockSessionId, title: "Найти дорогу к столице", description: "Пройти мимо дозоров.", status: "active", progress: 35, isMain: true, createdAt: now, updatedAt: now }],
  npcs: [{ id: "60000000-0000-4000-8000-000000000001", sessionId: mockSessionId, name: "Мара", role: "Посланник Хранителей", relation: 18, status: "alive", notes: "Знает безопасные тропы.", createdAt: now, updatedAt: now }],
  sceneObjects: [{ id: "70000000-0000-4000-8000-000000000001", sessionId: mockSessionId, locationName: "Тихая гавань", name: "Запечатанное письмо", description: "Бумага пахнет дымом.", state: "изучено", createdAt: now, updatedAt: now }],
  embeddings: { nodes: 2, ready: 2, pending: 0, processing: 0, failed: 0 },
};

const settings = {
  keysMasked: [], keysCount: 0, envKeysCount: 0, useLiveAI: false, routingProfile: "balanced",
  narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash",
  fastTaskModel: "gemini-3.5-flash-lite", dailyFlashLimit: 20, dailyLiteLimit: 500, enforceLimits: true,
  embeddingsEnabled: true, embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: true,
};

export async function installUiMock(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (process.env.UI_AUDIT_DEBUG === "1") console.log("UI MOCK", route.request().method(), path);
    let body: unknown = {};
    if (path === "/api/sessions") body = { sessions: [mockSession] };
    else if (path === "/api/settings") body = settings;
    else if (path === "/api/workspace") body = { displayName: "Искатель историй", favorites: ["ashen-crown"], reading: { textScale: "normal", measure: "normal", theme: "midnight", motion: "full" } };
    else if (path === "/api/tokens/stats") body = { today: { totalReq: 7, totalTokens: 12450, errors: 0, embeddingReq: 3 }, quotas: { note: "audit" } };
    else if (path === "/api/system/status") body = {
      version: "2.5", checkedAt: now, database: "connected",
      capabilities: { generation: false, embeddings: false, extraction: false, hasKeys: false, model: "gemini-embedding-2", dims: 768 },
      turns: { running: 0, completed: 3 }, checkpoints: 1, campaigns: 1,
      queues: { semantic: { pending: 1, processing: 0, completed: 2, failed: 0 }, embeddings: { pending: 0, processing: 0, ready: 2, failed: 0 }, staleSpace: 0, oldestPendingAt: now },
      worker: { online: false, status: "not-started", lastSeenAt: null, report: null }, lastManual: null, recentJobs: [],
    };
    else if (path === `/api/sessions/${mockSessionId}`) body = mockSnapshot;
    else if (path === `/api/sessions/${mockSessionId}/checkpoints`) body = { checkpoints: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}
