import type { AppliedChanges } from "@/db/schema";

/** Credential-free fallback describes only consequences actually accepted by reducers. */
export function offlineCanonicalNarration(input: { action: string; location: string; outcome: string; applied: AppliedChanges }): string {
  const lines = [`В «${input.location}» ты предпринимаешь действие: «${input.action}».`];
  if (input.outcome === "failure") lines.push("Попытка не удалась.");
  else if (input.outcome === "partial") lines.push("Попытка дала частичный результат.");
  else if (input.outcome === "success") lines.push("Проверка пройдена.");
  for (const item of input.applied.inventory) {
    if (!item.ok) continue;
    const verb = { add: "Получено", consume: "Использовано", remove: "Убрано из инвентаря", equip: "Надето", unequip: "Снято" }[item.op];
    lines.push(`${verb}: «${item.name}»${item.quantity ? ` ×${item.quantity}` : ""}.`);
  }
  const deltas = [["Здоровье", input.applied.hp], ["Опыт", input.applied.xp], ["Средства", input.applied.gold], ["Накал", input.applied.danger]] as const;
  for (const [label, value] of deltas) if (value) lines.push(`${label}: ${value > 0 ? "+" : ""}${value}.`);
  if (input.applied.conditions.added.length) lines.push(`Новые состояния: ${input.applied.conditions.added.join(", ")}.`);
  if (input.applied.conditions.removed.length) lines.push(`Прошли состояния: ${input.applied.conditions.removed.join(", ")}.`);
  lines.push("Автономный режим пресета: подключите Gemini для живого повествования.");
  return lines.join("\n\n");
}
