// ── INTERACT-2 / INTERACT-3 / NARR-7: универсальное состояние жизни мира ──
// Время, форма истории, обязательства и «у кого находится вещь» хранятся в world_state (jsonb).
// Так они автоматически переживают checkpoints, forks, копирование и JSON-перенос без новых таблиц.
// Модель ПРЕДЛАГАЕТ изменения (stateChanges.time/commitments/transfers/story);
// сервер валидирует их чистым reducer'ом applyLife и решает, что стало фактом.
import type { WorldState } from "@/db/schema";
import type { DbOp, InvRow, LocRow, MemoryEvent, NpcRow, ResolutionPayload } from "./resolution";

// ─────────────────────────────────────────────────────────────
//  Типы
// ─────────────────────────────────────────────────────────────
export type StoryShapeKind = "scene" | "open-life" | "arc";
export type StoryShape = {
  kind: StoryShapeKind;
  /** arc: цель, ставки, конфликт и условие завершения. */
  goal: string;
  stakes: string;
  conflict: string;
  endCondition: string;
  /** open-life/scene: текущие дела, намерения, фокус без навязанной кульминации. */
  focus: string[];
  status: "ongoing" | "resolved";
  resolvedTurn?: number;
  epilogue?: string;
};
export type WorldClock = { day: number; minute: number };
export type CommitmentStatus = "proposed" | "accepted" | "fulfilled" | "broken" | "cancelled";
export type Commitment = {
  id: string;
  title: string;
  parties: string[];
  place: string;
  due: WorldClock | null;
  status: CommitmentStatus;
  createdTurn: number;
  updatedTurn: number;
  note: string;
};
export type Holding = {
  id: string;
  name: string;
  description: string;
  quantity: number;
  holderKind: "npc" | "location";
  holderKey: string;
  holderName: string;
  turn: number;
};
export type WorldLife = { clock: WorldClock; story: StoryShape; commitments: Commitment[]; holdings: Holding[] };

/** Как сервер трактует сообщение игрока (INTERACT-3). */
export type IntentKind = "act" | "intend" | "claim" | "ask";

export type CommitmentChange = { ref: string | null; title: string; parties: string[]; place: string; day: number | null; time: string; status: CommitmentStatus | null; note: string };
export type TransferChange = { ref: string; to: string; quantity: number; accepted: boolean };
export type LifeChanges = {
  advanceMinutes: number | null;
  commitments: CommitmentChange[];
  transfers: TransferChange[];
  story: { status: "ongoing" | "resolved" | null; epilogue: string };
};
export type LifeApplied = {
  intent: IntentKind;
  clock: { from: string; to: string; minutes: number; newDay: boolean } | null;
  commitments: { title: string; status: CommitmentStatus; isNew: boolean; downgraded?: boolean }[];
  transfers: { name: string; to: string; quantity: number; ok: boolean; reason?: string }[];
  story: { kind: StoryShapeKind; resolved: boolean } | null;
};

export const STORY_SHAPE_LABELS: Record<StoryShapeKind, { title: string; description: string }> = {
  scene: { title: "Отдельная сцена", description: "Короткий эпизод: одна ситуация, без глав и обязательного финала." },
  "open-life": { title: "Открытая жизнь", description: "Повседневность, дела, отношения и планы. Главы — это дни, кульминация не навязывается." },
  arc: { title: "Сюжетная арка", description: "Цель, ставки, конфликт и условие завершения. Арку можно закончить эпилогом." },
};
export const COMMITMENT_LABELS: Record<CommitmentStatus, string> = {
  proposed: "Предложено", accepted: "Договорились", fulfilled: "Выполнено", broken: "Нарушено", cancelled: "Отменено",
};

const MAX_ACTIVE_COMMITMENTS = 16;
const MAX_COMMITMENTS = 40;
const MAX_HOLDINGS = 60;
const MAX_ADVANCE = 7 * 24 * 60;
const DAY = 24 * 60;

// ─────────────────────────────────────────────────────────────
//  Утилиты
// ─────────────────────────────────────────────────────────────
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export const normName = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е").replace(/[«»"'.,!?:;()]/g, "").replace(/\s+/g, " ");
const shortId = () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

/** Совпадение имени сущности с упоминанием: полное имя или основа первого слова (падежи). */
export function mentions(text: string, name: string): boolean {
  const t = ` ${normName(text)} `;
  const n = normName(name);
  if (!n) return false;
  if (t.includes(` ${n} `) || t.includes(n)) return true;
  const first = n.split(" ")[0];
  if (first.length < 4) return false;
  const stem = first.slice(0, Math.max(3, first.length - 2));
  return new RegExp(`(^|\\s)${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[а-яa-z]{0,4}(\\s|$)`).test(t);
}

export function parseClockTime(time: string): number | null {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

export function partOfDay(minute: number): string {
  const h = Math.floor(minute / 60);
  if (h < 5) return "ночь";
  if (h < 11) return "утро";
  if (h < 17) return "день";
  if (h < 22) return "вечер";
  return "ночь";
}

export function formatClock(c: WorldClock): string {
  const h = Math.floor(c.minute / 60), m = c.minute % 60;
  return `День ${c.day}, ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} (${partOfDay(c.minute)})`;
}

export function advanceClock(c: WorldClock, minutes: number): WorldClock {
  const total = (c.day - 1) * DAY + c.minute + Math.max(0, Math.round(minutes));
  return { day: Math.floor(total / DAY) + 1, minute: total % DAY };
}

export const clockValue = (c: WorldClock) => (c.day - 1) * DAY + c.minute;

// ─────────────────────────────────────────────────────────────
//  Чтение/нормализация (совместимость со старыми кампаниями)
// ─────────────────────────────────────────────────────────────
export function defaultStoryShape(world: Pick<WorldState, "mainQuest">, kind?: StoryShapeKind): StoryShape {
  const resolvedKind: StoryShapeKind = kind ?? (world.mainQuest ? "arc" : "open-life");
  return {
    kind: resolvedKind,
    goal: resolvedKind === "arc" ? (world.mainQuest ?? "").slice(0, 240) : "",
    stakes: "", conflict: "", endCondition: "", focus: [], status: "ongoing",
  };
}

export function normalizeStoryShape(raw: unknown, world: Pick<WorldState, "mainQuest">): StoryShape {
  if (!isRecord(raw)) return defaultStoryShape(world);
  const kind = (["scene", "open-life", "arc"] as const).includes(raw.kind as StoryShapeKind) ? (raw.kind as StoryShapeKind) : defaultStoryShape(world).kind;
  const shape: StoryShape = {
    kind,
    goal: str(raw.goal, 240),
    stakes: str(raw.stakes, 240),
    conflict: str(raw.conflict, 240),
    endCondition: str(raw.endCondition, 240),
    focus: (Array.isArray(raw.focus) ? raw.focus : []).map((f) => str(f, 120)).filter(Boolean).slice(0, 6),
    status: raw.status === "resolved" ? "resolved" : "ongoing",
  };
  if (typeof raw.resolvedTurn === "number") shape.resolvedTurn = raw.resolvedTurn;
  if (typeof raw.epilogue === "string" && raw.epilogue) shape.epilogue = raw.epilogue.slice(0, 1200);
  return shape;
}

export function readLife(world: WorldState): WorldLife {
  const clock = isRecord(world.clock) && Number.isFinite(world.clock.day) && Number.isFinite(world.clock.minute)
    ? { day: Math.max(1, Math.floor(world.clock.day)), minute: Math.min(DAY - 1, Math.max(0, Math.floor(world.clock.minute))) }
    : { day: 1, minute: 9 * 60 };
  return {
    clock,
    story: normalizeStoryShape(world.story, world),
    commitments: Array.isArray(world.commitments) ? world.commitments.filter(isRecord).slice(-MAX_COMMITMENTS) as Commitment[] : [],
    holdings: Array.isArray(world.holdings) ? world.holdings.filter(isRecord).slice(-MAX_HOLDINGS) as Holding[] : [],
  };
}

export function writeLife(world: WorldState, life: WorldLife): WorldState {
  return { ...world, clock: life.clock, story: life.story, commitments: life.commitments, holdings: life.holdings };
}

/** Обязательства, срок которых наступил или прошёл (для подсказок модели и UI). */
export function commitmentAlerts(life: Pick<WorldLife, "clock" | "commitments">): { due: Commitment[]; overdue: Commitment[] } {
  const now = clockValue(life.clock);
  const open = life.commitments.filter((c) => c.status === "accepted" && c.due);
  return {
    due: open.filter((c) => { const d = clockValue(c.due!); return d >= now && d - now <= 120; }),
    overdue: open.filter((c) => now - clockValue(c.due!) > 60),
  };
}

// ─────────────────────────────────────────────────────────────
//  INTERACT-3: намерение / попытка / утверждение
// ─────────────────────────────────────────────────────────────
const INTEND = /(^|[\s,.;])(хочу|хотел бы|хотела бы|собираюсь|планирую|намерен|намерена|думаю|мечтаю|надеюсь|позже|завтра|потом|когда-нибудь)(?=[\s,.;!?]|$)/i;
const CLAIM = /(^|[\s,.;])(я|меня|мне)\s+(получил[аи]?|нашел|нашла|нашёл|выиграл[аи]?|приняли|наняли|дали|подарили|согласил[аи]сь|уже|стал[аи]?)(?=[\s,.;!?]|$)|(он|она|они)\s+(согласил[аи]?сь|согласился|приняла?|поверил[аи]?)(?=[\s,.;!?]|$)/i;
// \b в JS не работает с кириллицей — границы слова задаются явно.
const ASK = /^(что|кто|где|когда|почему|зачем|как|сколько|какой|какая|какие|можно ли|есть ли)(?=[\s,]).*\?\s*$/i;

export function classifyIntent(action: string): IntentKind {
  const text = action.trim();
  if (!text) return "act";
  if (ASK.test(text)) return "ask";
  if (CLAIM.test(text)) return "claim";
  // «Хочу открыть дверь» в RPG-вводе обычно означает попытку; как намерение трактуются только
  // отложенные или передающие действия: «хочу подарить», «завтра отдам», «собираюсь предложить».
  if (INTEND.test(text) && /(подар|отда|переда|вруч|предлож|пообеща|продат|продам|купит|куплю|устро|позов|пригла|позвон|встрет|договор)/i.test(text)) return "intend";
  if (/(^|\s)(собираюсь|планирую|намерен|намерена|завтра|потом|позже)(\s|$)/i.test(text)) return "intend";
  return "act";
}

export const INTENT_LABELS: Record<IntentKind, string> = {
  act: "Действие", intend: "Намерение — ещё не совершено", claim: "Утверждение игрока — требует подтверждения сценой", ask: "Вопрос",
};

/**
 * Фильтр предложенных изменений по типу высказывания ДО reducers.
 * claim: игрок не может сам объявить, что цель выполнена или предмет получен без сцены.
 */
export function gateByIntent(payload: ResolutionPayload, intent: IntentKind): string[] {
  const rejected: string[] = [];
  const sc = payload.stateChanges;
  if (intent === "claim") {
    const before = sc.quests.length;
    sc.quests = sc.quests.filter((q) => q.status !== "completed");
    if (sc.quests.length < before) rejected.push("INTENT_CLAIM: завершение цели по утверждению игрока не принято — нужно событие в сцене");
  }
  if (intent === "ask") {
    const moved = !!sc.location && sc.location.action === "move";
    if (moved) { sc.location = null; rejected.push("INTENT_ASK: вопрос не перемещает героя"); }
    const consumed = sc.inventory.filter((i) => i.op === "consume" || i.op === "remove");
    if (consumed.length) { sc.inventory = sc.inventory.filter((i) => i.op !== "consume" && i.op !== "remove"); rejected.push("INTENT_ASK: вопрос не тратит предметы"); }
  }
  return rejected;
}

// ─────────────────────────────────────────────────────────────
//  Парсер предложенных изменений (часть RESOLUTION_RESPONSE_SCHEMA)
// ─────────────────────────────────────────────────────────────
export const LIFE_SCHEMA_PROPERTIES: Record<string, unknown> = {
  time: {
    type: "object",
    description: "Сколько игрового времени заняло действие",
    properties: { advanceMinutes: { type: "integer", description: "0–10080; разговор 5–20, дорога 15–90, ожидание — по запросу, сон 360–540" } },
    required: ["advanceMinutes"],
  },
  commitments: {
    type: "array",
    description: "Договорённости, встречи и обещания: новые (ref пустой) или изменение существующих по id",
    items: {
      type: "object",
      properties: {
        ref: { type: "string", description: "id существующего обязательства или пустая строка" },
        title: { type: "string" },
        parties: { type: "array", items: { type: "string" } },
        place: { type: "string" },
        day: { type: "integer", description: "День мира срока или -1" },
        time: { type: "string", description: "ЧЧ:ММ или пустая строка" },
        status: { type: "string", enum: ["proposed", "accepted", "fulfilled", "broken", "cancelled"] },
        note: { type: "string" },
      },
      required: ["ref", "title", "status"],
    },
  },
  transfers: {
    type: "array",
    description: "Передача предмета героя другому персонажу или оставление в месте; accepted=true только если получатель реально принял",
    items: {
      type: "object",
      properties: {
        ref: { type: "string", description: "#id предмета из инвентаря" },
        to: { type: "string", description: "key NPC или имя текущей локации" },
        quantity: { type: "integer" },
        accepted: { type: "boolean" },
      },
      required: ["ref", "to", "accepted"],
    },
  },
  story: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ongoing", "resolved"], description: "resolved — только если условие завершения арки реально выполнено" },
      epilogue: { type: "string" },
    },
    required: ["status"],
  },
};

export function emptyLifeChanges(): LifeChanges {
  return { advanceMinutes: null, commitments: [], transfers: [], story: { status: null, epilogue: "" } };
}

export function parseLifeChanges(sc: Record<string, unknown>): LifeChanges {
  const life = emptyLifeChanges();
  if (isRecord(sc.time) && sc.time.advanceMinutes != null && Number.isFinite(Number(sc.time.advanceMinutes))) {
    life.advanceMinutes = Math.max(0, Math.min(MAX_ADVANCE, Math.round(Number(sc.time.advanceMinutes))));
  }
  if (Array.isArray(sc.commitments)) {
    life.commitments = sc.commitments.filter(isRecord).slice(0, 4).map((c) => ({
      ref: str(c.ref, 40) || null,
      title: str(c.title, 140),
      parties: (Array.isArray(c.parties) ? c.parties : []).map((p) => str(p, 60)).filter(Boolean).slice(0, 5),
      place: str(c.place, 80),
      day: Number.isFinite(Number(c.day)) && Number(c.day) >= 1 ? Math.min(9999, Math.round(Number(c.day))) : null,
      time: str(c.time, 5),
      status: (["proposed", "accepted", "fulfilled", "broken", "cancelled"] as const).includes(c.status as CommitmentStatus) ? (c.status as CommitmentStatus) : null,
      note: str(c.note, 200),
    })).filter((c) => c.title || c.ref);
  }
  if (Array.isArray(sc.transfers)) {
    life.transfers = sc.transfers.filter(isRecord).slice(0, 4).map((t) => ({
      ref: str(t.ref, 64).replace(/^#/, ""),
      to: str(t.to, 80),
      quantity: Math.max(1, Math.min(20, Math.round(Number(t.quantity) || 1))),
      accepted: t.accepted === true,
    })).filter((t) => t.ref && t.to);
  }
  if (isRecord(sc.story)) {
    life.story = { status: sc.story.status === "resolved" ? "resolved" : sc.story.status === "ongoing" ? "ongoing" : null, epilogue: str(sc.story.epilogue, 1200) };
  }
  return life;
}

// ─────────────────────────────────────────────────────────────
//  Reducer
// ─────────────────────────────────────────────────────────────
export type ApplyLifeInput = {
  world: WorldState;
  inventory: InvRow[];
  npcs: NpcRow[];
  locations: LocRow[];
  life: LifeChanges;
  intent: IntentKind;
  /** Минуты по умолчанию из серверного контракта действия (INTERACT-1), если модель не указала время. */
  defaultMinutes: number;
  turnNumber: number;
  /** Предметы, уже затронутые inventory-операциями этого хода: повторно их не передаём. */
  touchedItemIds: Set<string>;
  /** Завершена ли главная цель в этом ходе (подтверждено reducers). */
  mainQuestCompleted: boolean;
  /** Имена предметов, реально добавленных герою в этом ходе (op add, ok). */
  addedItemNames?: string[];
  /** Точные количества предметов, реально добавленных герою в этом ходе. */
  addedItems?: { name: string; quantity: number }[];
  makeId?: () => string;
};
export type ApplyLifeResult = { world: WorldState; ops: DbOp[]; events: MemoryEvent[]; applied: LifeApplied; rejected: string[]; chapterBoundary: boolean | null };

export function applyLife(input: ApplyLifeInput): ApplyLifeResult {
  const makeId = input.makeId ?? shortId;
  const life = readLife(input.world);
  const ops: DbOp[] = [];
  const events: MemoryEvent[] = [];
  const rejected: string[] = [];
  const applied: LifeApplied = { intent: input.intent, clock: null, commitments: [], transfers: [], story: null };
  const currentLocation = input.world.currentLocation;

  // ── Время ──
  const minutes = input.life.advanceMinutes && input.life.advanceMinutes > 0 ? input.life.advanceMinutes : input.defaultMinutes;
  const before = life.clock;
  if (minutes > 0) {
    life.clock = advanceClock(before, Math.min(MAX_ADVANCE, minutes));
    applied.clock = { from: formatClock(before), to: formatClock(life.clock), minutes, newDay: life.clock.day > before.day };
    if (life.clock.day > before.day) {
      events.push({ layer: "episodic", category: "event", title: `Наступил день ${life.clock.day}`, content: `Время мира: ${formatClock(life.clock)}.`, importance: 35, entityKey: `clock:day:${life.clock.day}`, mode: "upsert" });
    }
  }

  // ── Передача предметов (INTERACT-2/3) ──
  const qtyLeft = new Map(input.inventory.map((i) => [i.id, i.quantity]));
  for (const t of input.life.transfers) {
    const item = input.inventory.find((i) => i.id === t.ref || i.id.startsWith(t.ref) || normName(i.name) === normName(t.ref));
    const toName = t.to;
    const reject = (reason: string) => { applied.transfers.push({ name: item?.name ?? t.ref, to: toName, quantity: t.quantity, ok: false, reason }); rejected.push(`TRANSFER: ${reason}`); };
    if (!item) { reject("предмета нет в инвентаре героя"); continue; }
    if (input.intent === "intend" || input.intent === "ask") { reject(`«${item.name}»: это намерение, а не совершённая передача`); continue; }
    if (!t.accepted) { reject(`«${item.name}»: получатель не принял предмет`); continue; }
    if (input.touchedItemIds.has(item.id)) { reject(`«${item.name}»: предмет уже изменён в этом ходе`); continue; }
    const left = qtyLeft.get(item.id) ?? 0;
    if (left < t.quantity) { reject(`«${item.name}»: недостаточно (есть ${left})`); continue; }
    const npc = input.npcs.find((n) => n.key === t.to || normName(n.name) === normName(t.to) || mentions(t.to, n.name));
    const loc = !npc ? input.locations.find((l) => normName(l.name) === normName(t.to) || l.id === t.to) : undefined;
    if (!npc && !loc) { reject(`«${item.name}»: неизвестный получатель «${toName}»`); continue; }
    if (npc && npc.status === "dead") { reject(`«${item.name}»: ${npc.name} не может принять предмет`); continue; }
    if (npc && npc.lastLocation && normName(npc.lastLocation) !== normName(currentLocation)) { reject(`«${item.name}»: ${npc.name} сейчас не рядом`); continue; }
    if (loc && normName(loc.name) !== normName(currentLocation)) { reject(`«${item.name}»: оставить можно только в текущем месте`); continue; }
    const holderName = npc ? npc.name : loc!.name;
    qtyLeft.set(item.id, left - t.quantity);
    input.touchedItemIds.add(item.id);
    if (left - t.quantity <= 0) ops.push({ t: "inv.delete", id: item.id });
    else ops.push({ t: "inv.update", id: item.id, patch: { quantity: left - t.quantity } });
    const existing = life.holdings.find((h) => normName(h.name) === normName(item.name) && h.holderKey === (npc ? npc.key : loc!.id));
    if (existing) { existing.quantity += t.quantity; existing.turn = input.turnNumber; }
    else life.holdings.push({ id: makeId(), name: item.name, description: item.description.slice(0, 200), quantity: t.quantity, holderKind: npc ? "npc" : "location", holderKey: npc ? npc.key : loc!.id, holderName, turn: input.turnNumber });
    applied.transfers.push({ name: item.name, to: holderName, quantity: t.quantity, ok: true });
    events.push({ layer: "semantic", category: "item", title: `«${item.name}» у ${holderName}`, content: `Ход ${input.turnNumber}: герой передал «${item.name}» ×${t.quantity} — теперь предмет ${npc ? `у ${npc.name}` : `оставлен в месте «${loc!.name}»`}.`, importance: 60, entityKey: `holding:${normName(item.name)}`, mode: "upsert" });
  }
  // Предмет снова оказался у героя (op add с тем же именем) — снимаем соответствующую запись владения.
  const returnedItems = input.addedItems ?? (input.addedItemNames ?? []).map((name) => ({ name, quantity: 1 }));
  for (const returned of returnedItems) {
    const quantity = Math.max(1, Math.min(20, Math.round(returned.quantity || 1)));
    const index = life.holdings.findIndex((h) => normName(h.name) === normName(returned.name) && (h.holderKind === "npc" || normName(h.holderName) === normName(currentLocation)));
    if (index >= 0) {
      const holding = life.holdings[index];
      const moved = Math.min(quantity, holding.quantity);
      holding.quantity -= moved;
      if (holding.quantity <= 0) life.holdings.splice(index, 1);
      events.push({ layer: "semantic", category: "item", title: `«${holding.name}» снова у героя`, content: `Ход ${input.turnNumber}: «${holding.name}» ×${moved} вернулся к герою (был ${holding.holderKind === "npc" ? `у ${holding.holderName}` : `в «${holding.holderName}»`}).`, importance: 55, entityKey: `holding:${normName(holding.name)}`, mode: "upsert" });
    }
  }
  if (life.holdings.length > MAX_HOLDINGS) life.holdings = life.holdings.slice(-MAX_HOLDINGS);

  // ── Обязательства ──
  for (const change of input.life.commitments) {
    let status = change.status ?? "proposed";
    let downgraded = false;
    if ((input.intent === "claim" || input.intent === "intend") && (status === "accepted" || status === "fulfilled")) {
      // «Я получил работу» / «хочу договориться» — ещё не принятое обязательство.
      status = "proposed"; downgraded = true;
      rejected.push(`COMMITMENT: «${change.title || change.ref}» остаётся предложением — нужно подтверждение сценой`);
    }
    const hasTime = !!change.time.trim();
    const dueMinute = parseClockTime(change.time);
    if (hasTime && dueMinute === null) {
      rejected.push(`COMMITMENT: «${change.title || change.ref}» содержит время в неверном формате`);
      continue;
    }
    const due: WorldClock | null = hasTime && dueMinute === null ? null : change.day != null || dueMinute != null ? { day: change.day ?? life.clock.day, minute: dueMinute ?? 12 * 60 } : null;
    const existing = change.ref ? life.commitments.find((c) => c.id === change.ref) : life.commitments.find((c) => change.title && normName(c.title) === normName(change.title) && !["fulfilled", "cancelled", "broken"].includes(c.status));
    if (existing) {
      if (["fulfilled", "cancelled", "broken"].includes(existing.status)) { rejected.push(`COMMITMENT: «${existing.title}» уже закрыто`); continue; }
      if (existing.status === "accepted" && downgraded) { continue; }
      existing.status = status;
      existing.updatedTurn = input.turnNumber;
      if (change.place) existing.place = change.place;
      if (due) existing.due = due;
      if (change.parties.length) existing.parties = change.parties;
      if (change.note) existing.note = `${existing.note ? existing.note + " " : ""}[ход ${input.turnNumber}] ${change.note}`.slice(-400);
      applied.commitments.push({ title: existing.title, status, isNew: false, ...(downgraded ? { downgraded } : {}) });
      events.push({ layer: "semantic", category: "quest", title: `Договорённость: ${existing.title}`, content: `${COMMITMENT_LABELS[status]}${existing.parties.length ? ` — ${existing.parties.join(", ")}` : ""}${existing.place ? `, место: ${existing.place}` : ""}${existing.due ? `, срок: ${formatClock(existing.due)}` : ""}.`, importance: status === "accepted" ? 70 : 55, entityKey: `commitment:${existing.id}`, mode: "upsert" });
    } else {
      if (!change.title) continue;
      if (life.commitments.filter((c) => c.status === "proposed" || c.status === "accepted").length >= MAX_ACTIVE_COMMITMENTS) { rejected.push("COMMITMENT: слишком много открытых договорённостей"); continue; }
      const created: Commitment = { id: makeId(), title: change.title, parties: change.parties, place: change.place, due, status, createdTurn: input.turnNumber, updatedTurn: input.turnNumber, note: change.note };
      life.commitments.push(created);
      applied.commitments.push({ title: created.title, status, isNew: true, ...(downgraded ? { downgraded } : {}) });
      events.push({ layer: "semantic", category: "quest", title: `Договорённость: ${created.title}`, content: `${COMMITMENT_LABELS[status]}${created.parties.length ? ` — ${created.parties.join(", ")}` : ""}${created.place ? `, место: ${created.place}` : ""}${created.due ? `, срок: ${formatClock(created.due)}` : ""}.`, importance: status === "accepted" ? 70 : 50, entityKey: `commitment:${created.id}`, mode: "upsert" });
    }
  }
  if (life.commitments.length > MAX_COMMITMENTS) {
    const open = life.commitments.filter((c) => c.status === "proposed" || c.status === "accepted");
    const closed = life.commitments.filter((c) => !(c.status === "proposed" || c.status === "accepted"));
    life.commitments = [...closed.slice(-(MAX_COMMITMENTS - open.length)), ...open];
  }

  // ── Форма истории и границы глав (NARR-7) ──
  let chapterBoundary: boolean | null = null;
  const shape = life.story;
  if (shape.status === "ongoing") {
    if (shape.kind === "arc") {
      const resolvedByModel = input.life.story.status === "resolved" && input.intent !== "claim" && !!(shape.endCondition || shape.goal);
      if (resolvedByModel || input.mainQuestCompleted) {
        shape.status = "resolved";
        shape.resolvedTurn = input.turnNumber;
        if (input.life.story.epilogue) shape.epilogue = input.life.story.epilogue;
        applied.story = { kind: shape.kind, resolved: true };
        chapterBoundary = true;
        events.push({ layer: "chronicle", category: "event", title: "Арка завершена", content: `Ход ${input.turnNumber}: ${shape.goal || "цель арки"} — достигнуто.${shape.epilogue ? ` Эпилог: ${shape.epilogue.slice(0, 300)}` : ""}`, importance: 90, entityKey: "story:arc", mode: "upsert" });
      }
    } else if (shape.kind === "open-life") {
      chapterBoundary = !!applied.clock?.newDay;
    } else {
      chapterBoundary = false;
    }
  }

  return { world: writeLife(input.world, life), ops, events, applied, rejected, chapterBoundary };
}

// ─────────────────────────────────────────────────────────────
//  Промпт
// ─────────────────────────────────────────────────────────────
export function describeStoryShape(shape: StoryShape): string {
  if (shape.kind === "arc") {
    const parts = [shape.goal && `цель: ${shape.goal}`, shape.stakes && `ставки: ${shape.stakes}`, shape.conflict && `конфликт: ${shape.conflict}`, shape.endCondition && `условие завершения: ${shape.endCondition}`].filter(Boolean);
    return `Сюжетная арка${shape.status === "resolved" ? " (ЗАВЕРШЕНА — веди эпилог/продолжение без новой кульминации, пока игрок не начнёт новую цель)" : ""}. ${parts.join("; ") || "цель формируется по ходу игры"}. Двигай к кульминации через решения игрока; не завершай арку без выполнения условия.`;
  }
  if (shape.kind === "open-life") {
    return `Открытая жизнь: повседневность, дела, отношения и планы. ${shape.focus.length ? `Текущие дела и намерения: ${shape.focus.join("; ")}. ` : ""}НЕ навязывай угрозы, злодеев, тайны и кульминацию; уважай бытовой реализм. Последствия — социальные, бытовые, временные.`;
  }
  return `Отдельная сцена: одна ситуация${shape.focus.length ? ` (${shape.focus.join("; ")})` : ""}. Держи единство места и времени, без глав и глобального сюжета.`;
}

export function buildLifePromptBlock(world: WorldState, intent: IntentKind, interactionDirective: string): string {
  const life = readLife(world);
  const alerts = commitmentAlerts(life);
  const open = life.commitments.filter((c) => c.status === "proposed" || c.status === "accepted");
  const commitments = open.length
    ? open.slice(-10).map((c) => `${c.id}: «${c.title}» [${COMMITMENT_LABELS[c.status]}]${c.parties.length ? ` с ${c.parties.join(", ")}` : ""}${c.place ? `, ${c.place}` : ""}${c.due ? `, срок ${formatClock(c.due)}` : ""}`).join("; ")
    : "нет";
  const holdings = life.holdings.length
    ? life.holdings.slice(-12).map((h) => `«${h.name}» ×${h.quantity} — ${h.holderKind === "npc" ? `у ${h.holderName}` : `лежит в «${h.holderName}»`}`).join("; ")
    : "нет";
  const intentRule = intent === "intend"
    ? "Игрок выразил НАМЕРЕНИЕ, а не совершил действие: опиши подготовку/предложение, но не передавай предметы (transfers) и не делай договорённость accepted."
    : intent === "claim"
      ? "Игрок УТВЕРЖДАЕТ результат («я получил…», «он согласился…»). Это не факт мира: разыграй сцену, где это может произойти или не произойти; не принимай утверждение как свершившееся."
      : intent === "ask"
        ? "Игрок задаёт ВОПРОС: ответь через восприятие героя, без перемещения и трат."
        : "Игрок совершает действие: опиши попытку и её реальный результат.";
  return `
ФОРМА ИСТОРИИ: ${describeStoryShape(life.story)}
ВРЕМЯ МИРА: ${formatClock(life.clock)}. Ход не равен фиксированному часу — укажи stateChanges.time.advanceMinutes по реальной длительности действия.
ДОГОВОРЁННОСТИ И ПЛАНЫ: ${commitments}${alerts.due.length ? `. СКОРО СРОК: ${alerts.due.map((c) => c.title).join(", ")}` : ""}${alerts.overdue.length ? `. ПРОСРОЧЕНО (мир реагирует): ${alerts.overdue.map((c) => c.title).join(", ")}` : ""}
ВЕЩИ НЕ У ГЕРОЯ: ${holdings}
ТИП ВЫСКАЗЫВАНИЯ ИГРОКА: ${INTENT_LABELS[intent]}. ${intentRule}
${interactionDirective}
· stateChanges.commitments — встречи/обещания/сделки: proposed — предложено; accepted — обе стороны явно согласились в сцене; fulfilled/broken/cancelled — закрытие существующего по ref.
· stateChanges.transfers — только когда предмет из инвентаря реально перешёл получателю в этой сцене (accepted=true). Отказ получателя — accepted=false.
· stateChanges.story.status = "resolved" — только при выполнении условия завершения арки; иначе "ongoing".`;
}
