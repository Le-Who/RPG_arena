import { COMMITMENT_LABELS } from "./world-life";
import type { AppliedChanges } from "@/db/schema";

export type ChangeIcon = "plus" | "consume" | "minus" | "equip" | "unequip" | "health" | "xp" | "gold" | "danger" | "level" | "warning" | "location" | "quest" | "check" | "failed" | "hidden" | "condition-add" | "condition-remove" | "person" | "object";
export type ChangeChip = { label: string; icon: ChangeIcon; tone: "positive" | "negative" | "neutral" };
export type ResourcePoint = { before: number; after: number };
export type ResourceSnapshot = { hp: ResourcePoint & { maxBefore: number; maxAfter: number }; gold: ResourcePoint; xp: ResourcePoint; danger: ResourcePoint; level?: ResourcePoint };
type ResourceCharacter = { hp: number; maxHp: number; gold: number; xp: number; level: number };
/** Capture accepted state; refresh after all turn repairs and downstream reducers. */
export function resourceSnapshot(before: ResourceCharacter, after: ResourceCharacter, danger: ResourcePoint): ResourceSnapshot {
  return {
    hp: { before: before.hp, after: after.hp, maxBefore: before.maxHp, maxAfter: after.maxHp },
    gold: { before: before.gold, after: after.gold }, xp: { before: before.xp, after: after.xp },
    danger: { ...danger }, ...(before.level !== after.level ? { level: { before: before.level, after: after.level } } : {}),
  };
}
const signed = (value: number) => `${value > 0 ? "+" : "−"}${Math.abs(value)}`;

/** Describe committed facts. Color is supplementary; the wording carries the meaning. */
export function describeAppliedChanges(applied: AppliedChanges): ChangeChip[] {
  const chips: ChangeChip[] = [];
  const add = (label: string, icon: ChangeIcon, tone: ChangeChip["tone"] = "neutral") => chips.push({ label, icon, tone });
  if (applied.location) add(`Переход: ${applied.location.from} → ${applied.location.to}`, "location");
  for (const [key, label, icon] of [["hp", "Здоровье", "health"], ["xp", "Опыт", "xp"], ["gold", "Средства", "gold"], ["danger", "Опасность", "danger"]] as const) {
    const value = applied[key];
    if (value) add(`${label} ${signed(value)}`, icon, (key === "danger" ? value < 0 : value > 0) ? "positive" : "negative");
  }
  if (applied.levelUp) add("Уровень повышен", "level", "positive");
  // The engine leaves the character alive at 1 HP; `dead` means near-death recovery.
  if (applied.dead) add("На грани гибели", "warning", "negative");
  for (const item of applied.inventory) {
    if (!item.ok) continue;
    const counted = `${item.name} ×${item.quantity}`;
    switch (item.op) {
      case "add": add(`Получено: ${counted}`, "plus", "positive"); break;
      case "consume": add(`Израсходовано: ${counted}`, "consume"); break;
      case "remove": add(`Удалено из инвентаря: ${counted}`, "minus", "negative"); break;
      case "equip": add(`Экипировано: ${item.name}`, "equip"); break;
      case "unequip": add(`Снято с экипировки: ${item.name}`, "unequip"); break;
      default: add(`Инвентарь: ${counted}`, "object");
    }
  }
  for (const quest of applied.quests) {
    switch (quest.status) {
      case "completed": add(`Цель выполнена: ${quest.title}`, "check", "positive"); break;
      case "failed": add(`Цель провалена: ${quest.title}`, "failed", "negative"); break;
      case "hidden": add(`Скрытая цель: ${quest.title}`, "hidden"); break;
      default: add(quest.isNew ? `Новая цель: ${quest.title} · ${quest.progress}%` : `Цель «${quest.title}»: прогресс ${quest.progress}%`, "quest");
    }
  }
  for (const condition of applied.conditions.added) add(`Состояние добавлено: ${condition}`, "condition-add");
  for (const condition of applied.conditions.removed) add(`Состояние снято: ${condition}`, "condition-remove");
  for (const npc of applied.npcs) {
    if (npc.isNew) add(`Новый персонаж: ${npc.name}`, "person");
    if (npc.delta) add(`Отношение: ${npc.name} ${signed(npc.delta)}`, "person", npc.delta > 0 ? "positive" : "negative");
    const statuses: Record<string, string> = { dead: "мёртв", missing: "пропал", unknown: "статус неизвестен" };
    if (statuses[npc.status]) add(`${npc.name}: ${statuses[npc.status]}`, "person", npc.status === "dead" ? "negative" : "neutral");
  }
  for (const object of applied.sceneObjects) add(`${object.name}: ${object.state}`, "object");
  // INTERACT-2/3, NARR-7: жизнь мира
  const life = applied.life;
  if (life) {
    if (life.story?.resolved) add("Арка завершена", "check", "positive");
    for (const t of life.transfers) add(t.ok ? `«${t.name}» → ${t.to}` : `Не передано: «${t.name}»`, t.ok ? "object" : "warning", t.ok ? "neutral" : "negative");
    for (const c of life.commitments) add(`${c.isNew ? "Новая договорённость" : "Договорённость"}: ${c.title} — ${c.rescheduled ? "перенесено" : COMMITMENT_LABELS[c.status].toLowerCase()}`, c.status === "broken" || c.status === "cancelled" ? "failed" : c.status === "fulfilled" ? "check" : "quest", c.status === "broken" ? "negative" : c.status === "fulfilled" || c.status === "accepted" ? "positive" : "neutral");
    if (life.clock && (life.clock.newDay || life.clock.minutes >= 60)) add(life.clock.newDay ? `Новый день · ${life.clock.to}` : `Прошло ${Math.round(life.clock.minutes / 60)} ч`, "hidden");
  }
  // WORLD-2: повестка мира
  if (applied.agenda) {
    for (const e of applied.agenda.fired) add(`Наступило: ${e.title}`, "hidden", "neutral");
    for (const e of applied.agenda.scheduled) add(`Запланировано: ${e.title} · ${e.at}`, "quest");
    for (const title of applied.agenda.cancelled) add(`Отменено: ${title}`, "failed");
    for (const g of applied.agenda.npcGoals) add(`${g.name}: ${g.goal ? `хочет ${g.goal}` : g.routine}`, "person");
  }
  // MECH-4: состояния, снятые временем
  // WORLD-2b/3b (2.9): люди мира
  if (applied.social) {
    for (const m of applied.social.missed) add(`Неявка: ${m.title}${m.penalty ? ` · отношения −${m.penalty}${m.parties.length ? ` (${m.parties.join(", ")})` : ""}` : " · без штрафа"}`, "failed", "negative");
    for (const s of applied.social.schedules) add(s.removed ? `${s.name}: больше не бывает в «${s.place}»` : `Распорядок: ${s.name} — «${s.place}», ${s.window}`, "person");
    for (const k of applied.social.knowledge) add(`${k.name} узнаёт: ${k.fact}`, "person");
    for (const o of applied.social.overdue) add(`Просрочено: ${o.title}`, "hidden");
  }
  for (const condition of applied.conditionTimers?.expired ?? []) add(`Прошло со временем: ${condition}`, "condition-remove", "positive");
  if (applied.interaction && !applied.interaction.valid) add(`Недоступно: ${applied.interaction.reasons[0] ?? applied.interaction.label}`, "warning", "negative");
  return chips;
}

// ─────────────────────────────────────────────────────────────
//  NARR-3: «что было → что стало → почему» по группам
// ─────────────────────────────────────────────────────────────
export type ConsequenceGroup = "Отношения" | "Ресурсы" | "Цели" | "Состояния" | "Люди и договорённости";
export type ConsequenceRow = { group: ConsequenceGroup; subject: string; before: string | null; after: string; reason: string };
const fmt = (value: number) => `${value > 0 ? "+" : ""}${value}`;
const questLabel = (status: string, progress: number) => status === "completed" ? "выполнена" : status === "failed" ? "провалена" : status === "hidden" ? "скрыта" : `${progress}%`;

export function describeConsequences(applied: AppliedChanges): ConsequenceRow[] {
  const rows: ConsequenceRow[] = [];
  for (const npc of applied.npcs) {
    if (npc.isNew) rows.push({ group: "Отношения", subject: npc.name, before: null, after: `знакомство, ${fmt(npc.relation)}`, reason: npc.note ?? "" });
    else if (npc.delta) rows.push({ group: "Отношения", subject: npc.name, before: fmt(npc.relation - npc.delta), after: fmt(npc.relation), reason: npc.note ?? "" });
  }
  for (const [key, label] of [["hp", "Здоровье"], ["gold", "Средства"], ["xp", "Опыт"], ["danger", "Опасность"]] as const) {
    const point = applied.resources?.[key];
    if (point) {
      const delta = point.after - point.before;
      const hp = key === "hp" ? applied.resources?.hp : undefined;
      if (!delta && (!hp || hp.maxBefore === hp.maxAfter)) continue;
      rows.push({ group: "Ресурсы", subject: label,
        before: hp ? `${point.before}/${hp.maxBefore}` : String(point.before),
        after: hp ? `${point.after}/${hp.maxAfter}` : String(point.after),
        reason: `${delta ? signed(delta) : "0"} за ход${key === "hp" && applied.dead ? " · на грани гибели" : ""}` });
    } else if (applied[key]) rows.push({ group: "Ресурсы", subject: label, before: null, after: signed(applied[key]), reason: "" });
  }
  if (applied.resources?.level) rows.push({ group: "Ресурсы", subject: "Уровень", before: String(applied.resources.level.before), after: String(applied.resources.level.after), reason: "набран опыт" });
  for (const quest of applied.quests) rows.push({ group: "Цели", subject: quest.title, before: quest.before ? questLabel(quest.before.status, quest.before.progress) : null, after: questLabel(quest.status, quest.progress), reason: [quest.isNew ? "новая цель" : "", quest.note ?? ""].filter(Boolean).join(" · ") });
  for (const condition of applied.conditions.added) rows.push({ group: "Состояния", subject: condition, before: "нет", after: "есть", reason: "" });
  for (const condition of applied.conditions.removed) rows.push({ group: "Состояния", subject: condition, before: "есть", after: "снято", reason: (applied.conditionTimers?.expired ?? []).includes(condition) ? "прошло со временем" : "" });
  for (const c of applied.life?.commitments ?? []) rows.push({ group: "Люди и договорённости", subject: c.title, before: null, after: c.rescheduled ? "перенесено" : COMMITMENT_LABELS[c.status].toLowerCase(), reason: c.downgraded ? "нужно подтверждение сценой" : "" });
  for (const m of applied.social?.missed ?? []) rows.push({ group: "Люди и договорённости", subject: m.title, before: "договорились", after: "неявка", reason: m.penalty ? `правило договорённости: отношения −${m.penalty}` : "правило последствий не задано — отношения не изменены" });
  for (const b of applied.social?.bonds ?? []) if (b.kind === "gift" || b.kind === "meeting" || b.kind === "knowledge") rows.push({ group: "Люди и договорённости", subject: b.name, before: null, after: b.text, reason: "" });
  return rows;
}
