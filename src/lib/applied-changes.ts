import type { AppliedChanges } from "@/db/schema";

export type ChangeIcon = "plus" | "consume" | "minus" | "equip" | "unequip" | "health" | "xp" | "gold" | "danger" | "level" | "warning" | "location" | "quest" | "check" | "failed" | "hidden" | "condition-add" | "condition-remove" | "person" | "object";
export type ChangeChip = { label: string; icon: ChangeIcon; tone: "positive" | "negative" | "neutral" };
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
  return chips;
}
