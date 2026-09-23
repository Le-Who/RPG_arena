"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, BookOpen, BrainCircuit, Compass, Feather, Globe2, LayoutGrid, Plus, Search, Settings2, Sparkles, UsersRound, type LucideIcon } from "lucide-react";
import { useApp } from "./app-shell";
import { Dialog } from "./dialog";
import { profileStorageKey } from "@/lib/ui-identity";
import { WORLDS } from "@/lib/ui-data";

type Command = { id: string; label: string; detail: string; keywords?: string; icon: LucideIcon; run: () => void };
export function CommandPalette({ onClose, suspended = false }: { onClose: () => void; suspended?: boolean }) {
  const { sessions, newStory, openSettings, workspace, updateReading, notify, identity, administration, playCommands } = useApp();
  const router = useRouter();
  const storageKey = identity ? profileStorageKey(identity, "recent-commands") : null;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => { const frame = requestAnimationFrame(() => { if (window.matchMedia("(min-width:781px)").matches) input.current?.focus(); try { const stored: unknown = JSON.parse((storageKey ? localStorage.getItem(storageKey) : null) ?? "[]"); if (Array.isArray(stored)) setRecentIds(stored.filter((id): id is string => typeof id === "string").slice(0, 5)); } catch {} }); return () => cancelAnimationFrame(frame); }, [storageKey]);
  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => { onClose(); router.push(path); };
    return [
      ...playCommands.map(command => ({ ...command, detail: "Текущая кампания", icon: BookOpen, run: () => { onClose(); requestAnimationFrame(command.run); } })),
      { id: "new", label: "Новая история", detail: "Выбрать мир и героя", keywords: "создать кампания", icon: Plus, run: () => newStory() },
      { id: "free", label: "Создать свой мир", detail: "Мир можно сохранить без ключа; для ходов нужен Gemini", icon: Sparkles, run: () => newStory(undefined, "free") },
      ...sessions.filter(s => s.status === "active").map(s => ({ id: `session:${s.id}`, label: s.title, detail: `Кампания · ${s.character.name} · ход ${s.turnCount}`, keywords: s.character.archetype, icon: BookOpen, run: go(`/play/${s.id}`) })),
      ...([{ href: "/", label: "Обзор", icon: LayoutGrid }, { href: "/campaigns", label: "Мои кампании", icon: BookOpen }, { href: "/worlds", label: "Библиотека миров", icon: Globe2 }, { href: "/characters", label: "Персонажи", icon: UsersRound }, { href: "/memory", label: "Память мира", icon: BrainCircuit }, { href: "/journal", label: "Журнал приключений", icon: Feather }, { href: "/system", label: "Пульс движка", icon: Activity }].filter(item => item.href !== "/system" || administration).map(item => ({ id: item.href, label: item.label, detail: "Перейти в раздел", icon: item.icon, run: go(item.href) }))),
      { id: "settings", label: "Настройки", detail: "AI-мастер, ключи и комфорт чтения", icon: Settings2, run: () => { onClose(); openSettings(); } },
      { id: "motion", label: workspace.reading.motion === "reduced" ? "Включить анимации" : "Уменьшить движение", detail: "Настройка сохраняется в вашем профиле", icon: Feather, run: () => { onClose(); void updateReading({ ...workspace.reading, motion: workspace.reading.motion === "reduced" ? "full" : "reduced" }); } },
      ...WORLDS.map(world => ({ id: `world:${world.id}`, label: world.title, detail: `Авторский мир · ${world.genre}`, keywords: world.worldName, icon: Compass, run: () => newStory(world.id) })),
    ];
  }, [sessions, administration, workspace.reading, newStory, onClose, router, openSettings, updateReading, playCommands]);
  const filtered = useMemo(() => {
    const words = query.toLocaleLowerCase("ru").trim().split(/\s+/).filter(Boolean);
    const found = commands.filter(command => words.every(word => `${command.label} ${command.detail} ${command.keywords ?? ""}`.toLocaleLowerCase("ru").includes(word)));
    if (!words.length && recentIds.length) found.sort((a, b) => {
      const rank = (id: string) => recentIds.includes(id) ? recentIds.indexOf(id) : 100;
      return rank(a.id) - rank(b.id);
    });
    return found.slice(0, words.length ? 16 : 10);
  }, [commands, query, recentIds]);
  const active = Math.min(selected, Math.max(0, filtered.length - 1));
  const execute = (command: Command) => {
    try { if (storageKey) localStorage.setItem(storageKey, JSON.stringify([command.id, ...recentIds.filter(id => id !== command.id)].slice(0, 5))); } catch {}
    try { command.run(); } catch { notify("Не удалось выполнить команду. Попробуйте ещё раз.", true); }
  };
  const move = (next: number) => {
    if (!filtered.length) return;
    const index = (next + filtered.length) % filtered.length;
    setSelected(index);
    list.current?.children[index]?.scrollIntoView({ block: "nearest" });
  };
  return <Dialog title="Командная палитра" onClose={onClose} suspended={suspended} className="command-dialog">
    <div className="eyebrow">ВАШ КОРОТКИЙ ПУТЬ</div><h2>Куда отправимся?</h2>
    <div className="command-search"><Search size={19} /><input ref={input} role="combobox" aria-label="Поиск миров, историй и команд" aria-expanded="true" aria-autocomplete="list" aria-controls="command-options" aria-activedescendant={filtered.length ? `command-option-${active}` : undefined} placeholder="История, мир или действие…" value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} onKeyDown={event => {
      if (event.key === "ArrowDown") { event.preventDefault(); move(active + 1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); move(active - 1); }
      else if (event.key === "Enter" && filtered[active]) { event.preventDefault(); execute(filtered[active]); }
    }} /></div>
    <div className="command-results" ref={list} role="listbox" id="command-options" aria-label="Результаты поиска">{filtered.map((command, index) => <button key={command.id} id={`command-option-${index}`} className="command-result" role="option" aria-selected={active === index} tabIndex={-1} onPointerMove={() => setSelected(index)} onClick={() => execute(command)}><command.icon size={18} /><div><strong>{command.label}</strong><small>{!query && recentIds.includes(command.id) ? "Недавно · " : ""}{command.detail}</small></div>{active === index && <kbd>↵</kbd>}</button>)}</div>
    {!filtered.length && <p className="command-empty" role="status">Пока ничего не найдено. Попробуйте название мира или «новая история».</p>}
    <div className="command-footer"><span><kbd>↑ ↓</kbd>Навигация</span><span><kbd>↵</kbd>Выбрать</span><span><kbd>Esc</kbd>Закрыть</span></div>
  </Dialog>;
}
