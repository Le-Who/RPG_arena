/** An explicit reference must never silently fall back to another entity's name. */
export function resolveInventoryReference<T extends { id: string; name: string }>(items: T[], ref: string | null | undefined, name: string | null | undefined): { entity?: T; error?: string } {
  const normalize = (value: string) => value.trim().toLocaleLowerCase("ru");
  if (ref) {
    const key = ref.replace(/^#/, "").toLowerCase();
    if (key.length < 6) return { error: "Ссылка на предмет слишком короткая." };
    const exact = items.find((item) => item.id.toLowerCase() === key);
    if (exact) return { entity: exact };
    const matches = items.filter((item) => item.id.toLowerCase().startsWith(key));
    if (matches.length !== 1) return { error: matches.length ? "Неоднозначная ссылка: нужен полный ID предмета." : "Предмет с указанным ID не принадлежит герою." };
    return { entity: matches[0] };
  }
  const matches = name ? items.filter((item) => normalize(item.name) === normalize(name)) : [];
  if (matches.length > 1) return { error: "Есть несколько предметов с этим именем. Укажите ID." };
  return { entity: matches[0] };
}
