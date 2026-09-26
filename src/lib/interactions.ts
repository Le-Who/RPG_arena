// ── INTERACT-1: контекстные действия над сущностями ──
// Один контракт для кнопки и свободного ввода: кнопка формирует каноническую фразу,
// сервер разбирает ЛЮБУЮ фразу тем же inferInteraction() и проверяет доступность
// (владение предметом, присутствие NPC, связность мест, состояние объекта).
// Модуль не зависит от Node/DB и используется и в UI, и на сервере.
import { mentions, normName } from "./world-life";

export type InteractionVerb = "inspect" | "take" | "use" | "give" | "open" | "talk" | "negotiate" | "move" | "wait";
export type EntityKind = "item" | "npc" | "object" | "location" | "holding";

export type InteractionState = {
  currentLocation: string;
  inventory: { id: string; name: string; quantity: number }[];
  npcs: { key: string; name: string; status: string; lastLocation?: string | null }[];
  sceneObjects: { key: string; name: string; state: string; locationName: string }[];
  locations: { id: string; name: string; discovered: boolean; current: boolean; connectedTo?: string[] | null }[];
  holdings?: { name: string; holderKind: "npc" | "location"; holderKey: string; holderName: string }[];
};

export type Interaction = {
  verb: InteractionVerb;
  target: { kind: EntityKind | "none"; ref: string; name: string };
  recipient?: { kind: "npc"; ref: string; name: string };
  minutes?: number;
};

export type InteractionCheck = { interaction: Interaction | null; valid: boolean; reasons: string[]; directive: string; defaultMinutes: number; label: string };

export const VERB_LABELS: Record<InteractionVerb, string> = {
  inspect: "Осмотреть", take: "Взять", use: "Использовать", give: "Передать", open: "Открыть",
  talk: "Поговорить", negotiate: "Договориться", move: "Отправиться", wait: "Подождать",
};

/** Минуты мира по умолчанию, если модель не указала длительность. */
export const VERB_MINUTES: Record<InteractionVerb, number> = {
  inspect: 5, take: 2, use: 5, give: 3, open: 2, talk: 15, negotiate: 20, move: 30, wait: 30,
};

export const WAIT_OPTIONS = [15, 60, 180, 480] as const;

// ─────────────────────────────────────────────────────────────
//  Каноническая фраза (кнопка → текст действия)
// ─────────────────────────────────────────────────────────────
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function interactionText(i: Interaction): string {
  const t = i.target.name;
  switch (i.verb) {
    case "inspect": return `Осмотреть «${t}»`;
    case "take": return `Взять «${t}»`;
    case "use": return `Использовать «${t}»`;
    case "give": return `Передать «${t}» — ${i.recipient?.name ?? "…"}`;
    case "open": return `Открыть «${t}»`;
    case "talk": return `Поговорить с «${t}»`;
    case "negotiate": return `Договориться с «${t}»: `;
    case "move": return `Отправиться в «${t}»`;
    case "wait": return `Подождать ${formatMinutes(i.minutes ?? 30)}`;
  }
}

// ─────────────────────────────────────────────────────────────
//  Доступные действия для сущности (UI)
// ─────────────────────────────────────────────────────────────
export type AvailableAction = { verb: InteractionVerb; label: string; enabled: boolean; reason?: string };

const here = (state: InteractionState, name?: string | null) => !name || normName(name) === normName(state.currentLocation);

export function npcPresent(state: InteractionState, npc: InteractionState["npcs"][number]): boolean {
  return npc.status !== "dead" && npc.status !== "missing" && here(state, npc.lastLocation);
}

export function locationReachable(state: InteractionState, loc: InteractionState["locations"][number]): { ok: boolean; reason?: string } {
  if (loc.current || normName(loc.name) === normName(state.currentLocation)) return { ok: false, reason: "Вы уже здесь" };
  if (!loc.discovered) return { ok: false, reason: "Место ещё не открыто" };
  const current = state.locations.find((l) => l.current) ?? state.locations.find((l) => normName(l.name) === normName(state.currentLocation));
  const links = [...(current?.connectedTo ?? [])];
  const reverse = (loc.connectedTo ?? []).includes(current?.id ?? "");
  // Карта без зафиксированных путей не блокирует переход: связь ещё не описана.
  if (current && links.length && !links.includes(loc.id) && !reverse) return { ok: false, reason: "Прямой путь отсюда не известен" };
  return { ok: true };
}

export function availableActions(kind: EntityKind, ref: string, state: InteractionState): AvailableAction[] {
  const make = (verb: InteractionVerb, enabled = true, reason?: string): AvailableAction => ({ verb, label: VERB_LABELS[verb], enabled, ...(reason ? { reason } : {}) });
  if (kind === "item") {
    const item = state.inventory.find((i) => i.id === ref);
    const present = state.npcs.some((n) => npcPresent(state, n));
    return [make("inspect", !!item), make("use", !!item), make("give", !!item && present, present ? undefined : "Рядом нет никого, кому можно передать")];
  }
  if (kind === "npc") {
    const npc = state.npcs.find((n) => n.key === ref);
    const ok = !!npc && npcPresent(state, npc);
    const reason = !npc ? "Неизвестный персонаж" : npc.status === "dead" ? "Персонаж погиб" : ok ? undefined : `Сейчас не рядом${npc.lastLocation ? ` (последний раз: ${npc.lastLocation})` : ""}`;
    return [make("talk", ok, reason), make("negotiate", ok, reason), make("inspect", !!npc && npc.status !== "dead" && ok, reason)];
  }
  if (kind === "object") {
    const object = state.sceneObjects.find((o) => o.key === ref);
    const ok = !!object && here(state, object.locationName);
    const reason = ok ? undefined : "Объект находится в другом месте";
    const open = object && /(открыт|распахнут|сломан|разбит)/i.test(object.state);
    return [make("inspect", ok, reason), make("open", ok && !open, open ? `Уже: ${object?.state}` : reason), make("use", ok, reason), make("take", ok, reason)];
  }
  if (kind === "holding") {
    const holding = state.holdings?.find((h) => h.holderKey + ":" + h.name === ref);
    const ok = !!holding && holding.holderKind === "location" && normName(holding.holderName) === normName(state.currentLocation);
    return [make("take", ok, ok ? undefined : "Вещь не здесь или у другого персонажа")];
  }
  const loc = state.locations.find((l) => l.id === ref);
  const reach = loc ? locationReachable(state, loc) : { ok: false, reason: "Неизвестное место" };
  return [make("move", reach.ok, reach.reason), make("inspect", !!loc?.current, loc?.current ? undefined : "Осмотреть можно только текущее место")];
}

// ─────────────────────────────────────────────────────────────
//  Разбор свободного ввода в тот же контракт
// ─────────────────────────────────────────────────────────────
const VERB_PATTERNS: [InteractionVerb, RegExp][] = [
  ["give", /(^|\s)(переда|подар|отда[мтюйёе]|отдать|вруч|протяну)/i],
  ["negotiate", /(^|\s)(договор|предлож|торгу|сторгов|убеди|попрош|уговор)/i],
  ["talk", /(^|\s)(поговор|заговор|спрос|расспрос|обрат|побесед|позвон|напис)/i],
  ["open", /(^|\s)(откр|отпер|отопр|взлом|распах)/i],
  ["take", /(^|\s)(взять|возьм|подобр|забра|забер|подня|прихват)/i],
  ["use", /(^|\s)(использ|примен|выпи|съе[сш]|включ|надень|надеть|активир)/i],
  ["move", /(^|\s)(отправ|пойти|пойд|идти|иду|поехать|поеду|еду|перейти|перейд|вернуться|вернусь|направ|добрат|доехать|дойти)/i],
  ["wait", /(^|\s)(подожд|подожду|ждать|жду|отдохн|поспать|посплю|лечь спать|переждать|скоротать)/i],
  ["inspect", /(^|\s)(осмотр|осмотре|изуч|рассмотр|оглядет|оглядыв|обыск|прочита|прочесть|проверить|провер)/i],
];

function parseMinutes(text: string): number | undefined {
  const m = /(\d{1,3})\s*(мин|минут|ч(?![а-я])|час|часа|часов)/i.exec(text);
  if (m) return Math.min(10080, Number(m[1]) * (/^ч|час/i.test(m[2]) ? 60 : 1));
  if (/до утра|всю ночь|поспать|посплю|лечь спать/i.test(text)) return 480;
  if (/до вечера/i.test(text)) return 240;
  if (/полчаса/i.test(text)) return 30;
  if (/час(?!т)/i.test(text)) return 60;
  return undefined;
}

function quoted(text: string): string[] {
  return [...text.matchAll(/«([^»]{1,120})»/g)].map((m) => m[1]);
}

/**
 * Разбирает текст действия. Кавычки «…» и привязанные itemIds дают точное совпадение;
 * иначе ищутся упоминания известных сущностей. Возвращает null, если действие не про сущность.
 */
export function inferInteraction(action: string, state: InteractionState, itemIds: string[] = []): Interaction | null {
  const text = action.trim();
  const verbEntry = VERB_PATTERNS.find(([, re]) => re.test(text));
  if (!verbEntry) return null;
  const verb = verbEntry[0];
  const names = quoted(text);
  const pick = <T,>(list: T[], name: (x: T) => string): T | undefined =>
    list.find((x) => names.some((n) => normName(n) === normName(name(x)))) ?? list.find((x) => mentions(text, name(x)));
  const boundItem = itemIds.length ? state.inventory.find((i) => i.id === itemIds[0]) : undefined;
  const item = boundItem ?? pick(state.inventory, (i) => i.name);
  const npc = pick(state.npcs, (n) => n.name);
  const object = pick(state.sceneObjects.filter((o) => here(state, o.locationName)), (o) => o.name) ?? pick(state.sceneObjects, (o) => o.name);
  const loc = pick(state.locations.filter((l) => l.discovered || names.length), (l) => l.name);
  const holding = pick(state.holdings ?? [], (h) => h.name);

  switch (verb) {
    case "wait": return { verb, target: { kind: "none", ref: "", name: "" }, minutes: parseMinutes(text) ?? 30 };
    case "give": {
      if (!item && !names[0]) return null;
      return { verb, target: item ? { kind: "item", ref: item.id, name: item.name } : { kind: "item", ref: "", name: names[0] }, ...(npc ? { recipient: { kind: "npc" as const, ref: npc.key, name: npc.name } } : {}) };
    }
    case "talk": case "negotiate":
      if (npc) return { verb, target: { kind: "npc", ref: npc.key, name: npc.name } };
      return null;
    case "move":
      if (loc) return { verb, target: { kind: "location", ref: loc.id, name: loc.name } };
      return names[0] ? { verb, target: { kind: "location", ref: "", name: names[0] } } : null;
    case "take":
      if (object) return { verb, target: { kind: "object", ref: object.key, name: object.name } };
      if (holding) return { verb, target: { kind: "holding", ref: holding.holderKey + ":" + holding.name, name: holding.name } };
      return null;
    case "use":
      if (item) return { verb, target: { kind: "item", ref: item.id, name: item.name } };
      if (object) return { verb, target: { kind: "object", ref: object.key, name: object.name } };
      return null;
    case "open":
      if (object) return { verb, target: { kind: "object", ref: object.key, name: object.name } };
      return null;
    case "inspect":
      if (item) return { verb, target: { kind: "item", ref: item.id, name: item.name } };
      if (npc) return { verb, target: { kind: "npc", ref: npc.key, name: npc.name } };
      if (object) return { verb, target: { kind: "object", ref: object.key, name: object.name } };
      if (loc) return { verb, target: { kind: "location", ref: loc.id, name: loc.name } };
      return null;
  }
}

/** Серверная проверка доступности. Нарушения не пишут состояние, а становятся жёсткими ограничениями сцены. */
export function checkInteraction(interaction: Interaction | null, state: InteractionState): InteractionCheck {
  if (!interaction) return { interaction: null, valid: true, reasons: [], directive: "", defaultMinutes: 5, label: "" };
  const reasons: string[] = [];
  const { verb, target } = interaction;
  if (target.kind === "item") {
    const item = state.inventory.find((i) => i.id === target.ref);
    if (!item) reasons.push(`У героя нет предмета «${target.name}»`);
  }
  if (target.kind === "npc") {
    const npc = state.npcs.find((n) => n.key === target.ref);
    if (!npc) reasons.push(`Персонаж «${target.name}» неизвестен`);
    else if (!npcPresent(state, npc)) reasons.push(npc.status === "dead" ? `${npc.name} погиб(ла)` : `${npc.name} сейчас не рядом${npc.lastLocation ? ` (последний раз: ${npc.lastLocation})` : ""}`);
  }
  if (target.kind === "object") {
    const object = state.sceneObjects.find((o) => o.key === target.ref);
    if (!object) reasons.push(`Объект «${target.name}» неизвестен`);
    else {
      if (!here(state, object.locationName)) reasons.push(`«${object.name}» находится в «${object.locationName}», а не здесь`);
      if (verb === "open" && /(открыт|распахнут)/i.test(object.state)) reasons.push(`«${object.name}» уже ${object.state}`);
    }
  }
  if (target.kind === "holding") {
    const holding = state.holdings?.find((h) => h.holderKey + ":" + h.name === target.ref);
    if (!holding) reasons.push(`Вещь «${target.name}» неизвестна`);
    else if (holding.holderKind === "npc") reasons.push(`«${holding.name}» сейчас у ${holding.holderName}: взять можно только с согласия`);
    else if (normName(holding.holderName) !== normName(state.currentLocation)) reasons.push(`«${holding.name}» осталась в «${holding.holderName}»`);
  }
  if (verb === "move" && target.kind === "location") {
    const loc = state.locations.find((l) => l.id === target.ref);
    if (!loc) reasons.push(`Место «${target.name}» неизвестно`);
    else { const reach = locationReachable(state, loc); if (!reach.ok) reasons.push(`Переход в «${loc.name}»: ${reach.reason}`); }
  }
  if (verb === "give") {
    if (!interaction.recipient) reasons.push("Не указан получатель");
    else {
      const npc = state.npcs.find((n) => n.key === interaction.recipient!.ref);
      if (!npc || !npcPresent(state, npc)) reasons.push(`${interaction.recipient.name} сейчас не рядом — передать нельзя`);
    }
  }
  const label = interactionText(interaction).replace(/: $/, "");
  const valid = reasons.length === 0;
  const refs = [target.ref && `${target.kind}:${target.ref}`, interaction.recipient && `npc:${interaction.recipient.ref}`].filter(Boolean).join(", ");
  const directive = valid
    ? `СЕРВЕРНО ПРОВЕРЕННОЕ ДЕЙСТВИЕ: ${VERB_LABELS[verb]} (${refs || "без цели"}). Доступность подтверждена; результат (согласие NPC, успех попытки) решает сцена.${verb === "give" ? " Предмет переходит только через stateChanges.transfers с accepted=true." : ""}${verb === "move" && target.ref ? ` При успехе — stateChanges.location.action=\"move\", ref=${target.ref}.` : ""}${verb === "wait" ? ` Герой ждёт ~${formatMinutes(interaction.minutes ?? 30)}: time.advanceMinutes не меньше этого.` : ""}`
    : `ДЕЙСТВИЕ НЕВОЗМОЖНО КАК ОПИСАНО (${reasons.join("; ")}). Опиши, что герой обнаруживает препятствие; НЕ применяй изменения, которые противоречат этому.`;
  const minutes = verb === "wait" ? interaction.minutes ?? VERB_MINUTES.wait : VERB_MINUTES[verb];
  return { interaction, valid, reasons, directive, defaultMinutes: valid ? minutes : 2, label };
}
