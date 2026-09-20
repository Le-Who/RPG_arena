"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Activity, ArrowRight, Bell, BookOpen, BookOpenText, BrainCircuit, Check, ChevronRight, Compass, Globe2, HelpCircle, LayoutGrid, Menu, MoreHorizontal, Plus, Search, Settings2, Sparkles, UserRound, UsersRound, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { WORLDS, coverFor, type Session, type Settings, type Workspace } from "@/lib/ui-data";
import { DEFAULT_READING, normalizeReading, readingAttributes } from "@/lib/reading-preferences";
import type { ReadingPreferences } from "@/db/schema";
import { Dialog } from "./dialog";
import { SettingsOverlay } from "./settings-overlay";
import { StoryCreator } from "./story-creator";
type AppContext = { settingsOpen: boolean; openSettings: () => void; sessions: Session[]; settings: Settings | null; workspace: Workspace; loading: boolean; loadError: string; refresh: () => Promise<void>; newStory: (id?: string, mode?: "preset" | "free") => void; notify: (message: string, error?: boolean) => void; toggleFavorite: (id: string) => Promise<void>; updateReading: (reading: ReadingPreferences) => Promise<void>; showGuide: () => void };
const Context = createContext<AppContext | null>(null);
export function useApp() { const value = useContext(Context); if (!value) throw new Error("App context missing"); return value; }
const navigation = [
  { href: "/", label: "Обзор", icon: LayoutGrid }, { href: "/campaigns", label: "Мои кампании", icon: BookOpen }, { href: "/worlds", label: "Библиотека миров", icon: Globe2 }, { href: "/characters", label: "Персонажи", icon: UsersRound },
];
const tools = [{ href: "/memory", label: "Память мира", icon: BrainCircuit }, { href: "/journal", label: "Журнал приключений", icon: BookOpenText }, { href: "/system", label: "Пульс движка", icon: Activity }];
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>({ displayName: "Искатель историй", favorites: [], reading: DEFAULT_READING });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [creator, setCreator] = useState<{ id?: string; mode: "preset" | "free" } | null>(null);
  const [dialog, setDialog] = useState<"guide" | "updates" | "search" | null>(null);
  const [search, setSearch] = useState("");
  const [sidebar, setSidebar] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("");
  const settingsTrigger = useRef<HTMLElement | null>(null);
  const openSettings = useCallback((section = "") => { setSettingsSection(section); settingsTrigger.current = document.activeElement as HTMLElement | null; setSidebar(false); setSettingsOpen(true); }, []);
  const closeSettings = useCallback(() => { setSettingsOpen(false); requestAnimationFrame(() => settingsTrigger.current?.focus({ preventScroll: true })); }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width:780px)");
    const sync = () => setMobile(media.matches);
    const timer = window.setTimeout(() => { sync(); try { setDesktopCollapsed(localStorage.getItem("chronicle:sidebar-collapsed") === "1"); } catch {} }, 0);
    media.addEventListener("change", sync);
    return () => { clearTimeout(timer); media.removeEventListener("change", sync); };
  }, []);
  const toggleSidebar = () => {
    if (mobile) { setSidebar(!sidebar); return; }
    const next = !desktopCollapsed; setDesktopCollapsed(next);
    try { localStorage.setItem("chronicle:sidebar-collapsed", next ? "1" : "0"); } catch {}
  };
  const interceptSettings = (event: MouseEvent<HTMLDivElement>) => {
    if (settingsOpen || (!pathname.startsWith("/play/") && !creator) || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest("a[href]");
    if (!anchor) return;
    const url = new URL(anchor.getAttribute("href")!, window.location.href);
    if (url.origin === window.location.origin && url.pathname === "/settings") { event.preventDefault(); event.stopPropagation(); openSettings(url.hash.slice(1)); }
  };
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const refresh = useCallback(async () => {
    try {
      const [s, a, w] = await Promise.all([api<{ sessions: Session[] }>("/api/sessions"), api<Settings>("/api/settings"), api<Workspace>("/api/workspace")]);
      setSessions(s.sessions); setSettings(a); setWorkspace(w); setLoadError("");
    } catch (error) { setLoadError(error instanceof Error ? error.message : "Не удалось загрузить пространство"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    const root = document.documentElement;
    const attributes = readingAttributes(workspace.reading);
    for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
    return () => { for (const name of Object.keys(attributes)) root.removeAttribute(name); };
  }, [workspace.reading]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (!document.querySelector('[role="dialog"]:not([hidden])') && (e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setDialog("search"); } }; document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key); }, []);
  const newStory = useCallback((id?: string, mode: "preset" | "free" = "preset") => { setDialog(null); setCreator({ id, mode }); }, []);
  const closeCreator = useCallback(() => setCreator(null), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const toggleFavorite = async (id: string) => {
    if (favoriteBusy) return;
    setFavoriteBusy(true);
    const previous = workspace;
    const favorites = workspace.favorites.includes(id) ? workspace.favorites.filter((s) => s !== id) : [...workspace.favorites, id];
    setWorkspace({ ...workspace, favorites });
    try { await api("/api/workspace", { method: "PATCH", body: JSON.stringify({ favorites }) }); }
    catch (error) { setWorkspace(previous); notify(error instanceof Error ? error.message : "Не удалось сохранить", true); }
    finally { setFavoriteBusy(false); }
  };
  const updateReading = useCallback(async (reading: ReadingPreferences) => {
    const next = normalizeReading(reading);
    let previous: Workspace | null = null;
    setWorkspace((old) => { previous = old; return { ...old, reading: next }; });
    try { await api("/api/workspace", { method: "PATCH", body: JSON.stringify({ reading: next }) }); }
    catch (error) { if (previous) setWorkspace(previous); notify(error instanceof Error ? error.message : "Не удалось сохранить настройки чтения", true); }
  }, [notify]);
  const title = [...navigation, ...tools, { href: "/settings", label: "Настройки" }, { href: "/blueprint", label: "О движке" }].find((item) => item.href === pathname)?.label ?? "Ваша история";
  const live = Boolean(settings?.useLiveAI && (settings.keysCount + settings.envKeysCount > 0));
  const activeCount = sessions.filter((s) => s.status === "active").length;
  const navItem = (item: (typeof navigation)[number]) => <Link key={item.href} href={item.href} className={`nav-item ${pathname === item.href ? "active" : ""}`} onClick={() => setSidebar(false)}><item.icon size={18} strokeWidth={1.65} /><span>{item.label}</span>{item.href === "/campaigns" && activeCount > 0 && <span className="nav-count">{activeCount}</span>}{item.href === "/worlds" && <span className="nav-count neutral">{WORLDS.length}</span>}</Link>;
  return <Context.Provider value={{ settingsOpen, openSettings, sessions, settings, workspace, loading, loadError, refresh, newStory, notify, toggleFavorite, updateReading, showGuide: () => setDialog("guide") }}>
    <div className="shell-root" data-sidebar-collapsed={!mobile && desktopCollapsed ? "true" : "false"} onClickCapture={interceptSettings}><div inert={settingsOpen || !!creator || !!dialog}>
    <a className="skip-link" href="#main-content">Перейти к содержимому</a>
    {sidebar && <div className="mobile-shade" onClick={() => setSidebar(false)} />}
    <aside id="app-navigation" className={`sidebar ${sidebar ? "is-open" : ""}`} inert={mobile ? !sidebar : desktopCollapsed}>
      <Link href="/" className="brand" onClick={() => setSidebar(false)}><span className="brand-symbol"><svg viewBox="0 0 48 48" fill="none"><path d="m24 3 18 10v22L24 45 6 35V13L24 3Zm0 0L14 24l10 21 10-21L24 3ZM6 13l28 11L6 35m36-22L14 24l28 11" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg></span><span className="brand-word">CHRONICLE<span>ENGINE</span></span></Link>
      <div className="workspace-switch"><span className="workspace-icon"><Compass size={18} /></span><div>Личное пространство<small>Здесь живут ваши истории</small></div></div>
      <div className="nav-label">ПРОСТРАНСТВО</div><nav aria-label="Основная навигация">{navigation.map(navItem)}</nav>
      <div className="nav-label tools-label">ИНСТРУМЕНТЫ</div><nav aria-label="Инструменты">{tools.map(navItem)}</nav>
      <div className="sidebar-spacer" />
      <div className="imagination-card"><span className="imagination-spark"><Sparkles size={22} strokeWidth={1.4} /></span><strong>Не находите свой мир?</strong><p>Там, где заканчиваются шаблоны, начинается ваша история.</p><button onClick={() => newStory(undefined, "free")}>Создать свой мир <ArrowRight size={14} /></button><div className="card-orbit" /></div>
      <Link href="/settings" className={`nav-item bottom-settings ${pathname === "/settings" ? "active" : ""}`} onClick={() => setSidebar(false)}><Settings2 size={18} strokeWidth={1.6} /><span>Настройки</span><span className="version-tag">v2.5</span></Link>
      <div className="profile-row"><span className="avatar">{workspace.displayName[0]}</span><div><strong>{workspace.displayName}</strong><small>Автор своей истории</small></div><Link className="icon-button" href="/settings#profile" aria-label="Настройки профиля"><MoreHorizontal size={18} /></Link></div>
    </aside>
    <div className="app-body"><header className="topbar"><button className="icon-button menu-toggle" onClick={toggleSidebar} aria-controls="app-navigation" aria-expanded={mobile ? sidebar : !desktopCollapsed} aria-label={(mobile ? sidebar : !desktopCollapsed) ? "Скрыть меню" : "Открыть меню"}><Menu size={21} /></button><div className="breadcrumbs"><Compass size={15} /><span>Пространство</span><ChevronRight size={13} /><strong>{title}</strong></div><div className="topbar-actions"><button className="global-search" onClick={() => setDialog("search")} aria-label="Поиск по пространству"><Search size={16} /><span>Быстрый поиск</span><kbd>⌘ K</kbd></button><Link className={`connection-status ${live ? "live" : ""}`} href="/settings"><i />{live ? "Gemini подключён" : "Автономный режим"}</Link><div className="topbar-divider" /><button className="icon-button" onClick={() => setDialog("guide")} aria-label="Как это работает"><HelpCircle size={19} /></button><button className="icon-button notification-button" onClick={() => setDialog("updates")} aria-label="Обновления движка"><Bell size={18} /><i /></button></div></header><main className="main-content" id="main-content">{children}</main></div>
    </div>
    {settingsOpen && <SettingsOverlay section={settingsSection} onClose={closeSettings} returnLabel={creator ? "Вернуться к истории" : "Вернуться в игру"} />}
    {creator && <StoryCreator initialScenario={creator.id} initialMode={creator.mode} onClose={closeCreator} onCreated={refresh} live={live} onSettings={() => openSettings()} suspended={settingsOpen} />}
    {dialog === "guide" && <Dialog onClose={closeDialog} title="Как это работает" suspended={settingsOpen}><span className="dialog-emblem"><Compass size={27} /></span><div className="eyebrow">ВАША ИСТОРИЯ, ВАШИ ПРАВИЛА</div><h2>Здесь нет неправильного пути</h2><p className="dialog-intro">Chronicle Engine — интерактивная история, в которой вы не зритель, а главный герой.</p><div className="guide-steps">{[{ n: "01", title: "Найдите свой мир", text: "Выберите авторский сценарий или придумайте собственный сеттинг — от уютной драмы до далёких галактик." }, { n: "02", title: "Сделайте первый шаг", text: "Выбирайте предложенные действия или пишите свои. Мир ответит, а сервер проверит последствия." }, { n: "03", title: "Оставьте след в истории", text: "Предметы, отношения и принятые решения сохраняются. Память помогает ИИ не терять нить повествования." }].map((step) => <div key={step.n}><span>{step.n}</span><section><h3>{step.title}</h3><p>{step.text}</p></section></div>)}</div><div className="notice"><Sparkles size={17} /><p>Пресеты работают без AI. Для свободной истории и семантического поиска подключите Gemini в настройках.</p></div><button className="button primary full-width" onClick={() => newStory()}>Отправиться в приключение <ArrowRight size={16} /></button></Dialog>}
    {dialog === "updates" && <Dialog onClose={closeDialog} title="Обновления" suspended={settingsOpen}><span className="pill violet">CHRONICLE ENGINE · 2.5</span><h2>История<br />под вас.</h2><p className="dialog-intro">Комфорт чтения, карта мира и более лёгкий движок.</p><div className="update-list">{["Комфорт чтения: размер прозы, ширина строки, три палитры", "Карта известного мира с рисками и быстрым переходом", "Клавиатура: 1–9, «/», стрелки между панелями, skip-link", "Лента ходов рендерится лениво, снапшот стал легче", "Убраны зависимости от устаревших полей и одноразовых скриптов"].map((text) => <p key={text}><Check size={17} />{text}</p>)}</div><Link href="/blueprint" onClick={closeDialog} className="button secondary full-width">Заглянуть под капот <ArrowRight size={16} /></Link></Dialog>}
    {dialog === "search" && <Dialog title="Быстрый поиск" onClose={closeDialog} suspended={settingsOpen} className="search-dialog"><h2>Куда отправимся?</h2><div className="search-field large"><Search size={19} /><input autoFocus placeholder="Мир, кампания или герой…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><div className="search-results">{sessions.filter((s) => `${s.title} ${s.character.name}`.toLowerCase().includes(search.toLowerCase())).slice(0, 4).map((s) => <Link href={`/play/${s.id}`} key={s.id} onClick={closeDialog}><Image src={coverFor(s.scenarioId)} alt="" width={60} height={44} sizes="60px" /><div><strong>{s.title}</strong><small>Кампания · {s.character.name}</small></div><ArrowRight size={16} /></Link>)}{WORLDS.filter((s) => `${s.title} ${s.genre} ${s.worldName}`.toLowerCase().includes(search.toLowerCase())).slice(0, 5).map((s) => <button key={s.id} onClick={() => newStory(s.id)}><Image src={coverFor(s.id)} alt="" width={60} height={44} sizes="60px" /><div><strong>{s.title}</strong><small>Авторский мир · {s.genre}</small></div><Plus size={16} /></button>)}{!sessions.some((s) => `${s.title} ${s.character.name}`.toLowerCase().includes(search.toLowerCase())) && !WORLDS.some((s) => `${s.title} ${s.genre} ${s.worldName}`.toLowerCase().includes(search.toLowerCase())) && <p className="empty-inline">Ничего не найдено. Возможно, этот мир ещё предстоит создать?</p>}</div></Dialog>}
    {toast && <div className={`toast ${toast.error ? "toast-error" : ""}`} role="status" inert={settingsOpen || !!creator || !!dialog}>{toast.error ? <HelpCircle size={18} /> : <Check size={18} />}<span>{toast.text}</span><button className="icon-button" aria-label="Закрыть уведомление" onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  </Context.Provider>;
}
