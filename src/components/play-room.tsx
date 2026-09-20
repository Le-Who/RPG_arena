"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type React from "react";
import { ArrowDown, ArrowLeft, ArrowRight, Backpack, BookOpen, BookOpenText, BrainCircuit, Check, ChevronUp, Compass, CornerDownLeft, Dices, Download, Feather, Flag, GitBranch, Globe2, Heart, LoaderCircle, MapPin, Minimize2, Plus, RefreshCw, Send, ShieldCheck, Sparkles, UserRound, WifiOff } from "lucide-react";
import { useApp } from "./app-shell";
import { api, jsonBody } from "@/lib/api-client";
import { coverFor, PROFILE_LABELS, SOURCE_LABELS, type Snapshot } from "@/lib/ui-data";
import type { AppliedChanges } from "@/db/schema";
import type { TurnResponse } from "@/lib/turn-contract";
import { TURN_STAGE_LABELS } from "@/lib/turn-contract";
import { CheckpointDialog } from "./checkpoint-dialog";
import { useTurnRequest } from "./use-turn-request";
import { classifyAction } from "@/lib/action-kind";
import { WorldMap } from "./world-map";

const SIDE_TABS = [
  { id: "hero", icon: UserRound, title: "Герой" },
  { id: "inventory", icon: Backpack, title: "Вещи" },
  { id: "world", icon: Globe2, title: "Мир" },
  { id: "memory", icon: BrainCircuit, title: "Память" },
] as const;

function lastNarratorChoices(snapshot: Snapshot | null): string[] {
  if (!snapshot) return [];
  const last = [...snapshot.turns].reverse().find((turn) => turn.role === "narrator");
  return last?.choices ?? [];
}

export function PlayRoom({ sessionId }: { sessionId: string }) {
  const { settings, sessions, refresh, notify } = useApp();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [action, setAction] = useState("");
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const closeCheckpoints = useCallback(() => setShowCheckpoints(false), []);
  const [sideTab, setSideTab] = useState<(typeof SIDE_TABS)[number]["id"]>("hero");
  const [reading, setReading] = useState(false);
  const [compactNeeded, setCompactNeeded] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [older, setOlder] = useState<Snapshot["turns"]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedChoice, setSelectedChoice] = useState(-1);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: SIDE_TABS.length - 1 };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = (target + SIDE_TABS.length) % SIDE_TABS.length;
    setSideTab(SIDE_TABS[next].id);
    tabRefs.current[next]?.focus();
  };
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const actionZoneRef = useRef<HTMLDivElement>(null);
  const [actionVisible, setActionVisible] = useState(true);
  const reload = useCallback(async () => {
    const result = await api<Snapshot>(`/api/sessions/${sessionId}?memories=8`);
    setSnapshot(result); setLoadError(""); return result;
  }, [sessionId]);
  const onCommitted = useCallback(async (result: TurnResponse) => {
    const suppressScroll = !!document.querySelector('[role="dialog"]');
    setCompactNeeded(result.needsCompaction); setAction("");
    await reload(); void refresh();
    if (!suppressScroll) setTimeout(() => { if (!document.querySelector('[role="dialog"]')) document.getElementById(`turn-${result.turnNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }, 80);
  }, [reload, refresh]);
  const turnRequest = useTurnRequest(sessionId, onCommitted);
  const { busy, error: actionError } = turnRequest;
  const sendTurn = turnRequest.send;
  useEffect(() => {
    if (!turnRequest.pending) return;
    const timer = window.setTimeout(() => setAction(turnRequest.pending?.action ?? ""), 0);
    return () => window.clearTimeout(timer);
  }, [turnRequest.pending]);
  useEffect(() => {
    let active = true;
    api<Snapshot>(`/api/sessions/${sessionId}?memories=8`).then((result) => {
      if (!active) return; setSnapshot(result);
      if (window.location.hash && !document.querySelector('[role="dialog"]')) setTimeout(() => { if (!document.querySelector('[role="dialog"]')) document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "center" }); }, 150);
    }).catch((e) => { if (active) setLoadError(e.message); });
    return () => { active = false; };
  }, [sessionId]);
  // Nudge: when the action zone leaves the viewport, offer a way back to it.
  useEffect(() => {
    const node = actionZoneRef.current;
    if (!node) return;
    const io = new IntersectionObserver(([entry]) => setActionVisible(entry.isIntersecting), { rootMargin: "-40px 0px -80px 0px" });
    io.observe(node);
    return () => io.disconnect();
  }, [snapshot]);
  const act = useCallback(async (text: string) => {
    if (busy || !text.trim() || !snapshot) return;
    const pending = turnRequest.pending;
    const fresh = classifyAction(text, lastNarratorChoices(snapshot));
    const { action: submitted, custom, choice } = pending && pending.action === text.trim() ? { action: pending.action, custom: pending.custom, choice: -1 } : fresh;
    setSelectedChoice(choice);
    try { const ok = await sendTurn(submitted, custom, snapshot.session.turnCount); if (!ok) await reload().catch(() => {}); }
    finally { setSelectedChoice(-1); }
  }, [busy, reload, sendTurn, snapshot, turnRequest.pending]);
  const submit = (e: FormEvent) => { e.preventDefault(); void act(action); };
  const choices = lastNarratorChoices(snapshot);
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    shortcutRef.current = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") { event.preventDefault(); composerRef.current?.focus(); return; }
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) { event.preventDefault(); void act(choices[index]); }
    };
  }, [choices, act]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const addItemToAction = (name: string, id: string) => { setAction(`Использовать «${name}» #${id.slice(0, 6)}: `); composerRef.current?.focus(); };
  const loadEarlier = async () => {
    if (!snapshot) return;
    const before = Math.min(...[...older, ...snapshot.turns].map((turn) => turn.turnNumber));
    setLoadingOlder(true);
    try { const result = await api<{ turns: Snapshot["turns"] }>(`/api/sessions/${sessionId}/turns?before=${before}`); setOlder((old) => [...result.turns, ...old]); } catch (e) { notify(e instanceof Error ? e.message : "Не удалось загрузить ходы", true); } finally { setLoadingOlder(false); }
  };
  const compact = async () => { setCompacting(true); try { await api(`/api/sessions/${sessionId}/compact`, jsonBody({})); await reload(); setCompactNeeded(false); notify("Новые главы сохранены в долгосрочной памяти"); } catch (e) { notify(e instanceof Error ? e.message : "Не удалось сохранить память", true); } finally { setCompacting(false); } };
  const restore = async () => { try { await api(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }); await reload(); void refresh(); } catch (e) { notify(e instanceof Error ? e.message : "Ошибка", true); } };

  if (loadError) return <div className="empty-state gx-fallback"><BookOpen size={34} /><h3>Не удалось открыть эту главу</h3><p>{loadError}</p><button className="button secondary" onClick={() => void reload().catch((e) => setLoadError(e.message))}><RefreshCw size={15} />Попробовать снова</button><Link className="text-link" href="/campaigns">Вернуться к кампаниям</Link></div>;
  if (!snapshot) return <div className="gx-loading"><span className="gx-loading-orb"><LoaderCircle size={30} className="spin" /></span><h2>Открываем вашу историю…</h2><p>Загружаем мир, персонажей и сохранённые решения.</p></div>;

  const { session, inventory, memories, locations, quests, npcs, sceneObjects } = snapshot;
  const character = session.character;
  const world = session.worldState;
  const live = Boolean(settings?.useLiveAI && settings.keysCount + settings.envKeysCount > 0);
  const turns = [...older, ...snapshot.turns].filter((turn, index, all) => all.findIndex((t) => t.id === turn.id) === index);
  const lastNarrator = [...snapshot.turns].reverse().find((turn) => turn.role === "narrator");
  const active = session.status === "active";
  const canAct = active && !busy;

  return <div className={`gx-room ${reading ? "gx-reading" : ""}`}>
    <div className="gx-topbar">
      <Link href="/campaigns" className="gx-back"><ArrowLeft size={16} /><span>Мои кампании</span></Link>
      <div className="gx-topbar-title"><MapPin size={13} />{world.currentLocation}</div>
      <div className="gx-topbar-actions">
        <span className={`gx-save ${busy ? "is-busy" : ""}`}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}<span>{busy ? "Ход в обработке" : "Сохранено"}</span></span>
        <button className="gx-tool" aria-label="Развилки истории" title="Развилки истории" onClick={() => setShowCheckpoints(true)} disabled={busy}><GitBranch size={16} /><span>Развилки</span></button>
        <a className="gx-tool icon-only" href={`/api/sessions/${sessionId}/export`} title="Скачать историю" aria-label="Скачать историю"><Download size={16} /></a>
        <button className="gx-tool icon-only" onClick={() => setReading(!reading)} aria-label={reading ? "Выйти из режима чтения" : "Режим чтения"} title={reading ? "Обычный режим" : "Режим чтения"}>{reading ? <Minimize2 size={16} /> : <BookOpenText size={17} />}</button>
      </div>
    </div>

    <div className="gx-banner" style={{ backgroundImage: `linear-gradient(101deg, #14121cf7 0%, #14121cde 44%, #161320a8 70%, #1a172655 100%), url(${coverFor(session.scenarioId)})` }}>
      <div className="gx-banner-body">
        <div className="gx-eyebrow">Глава {world.chapter} · {session.campaignMode === "preset" ? "Авторская история" : "Ваш собственный мир"}</div>
        <h1>{session.title}</h1>
        <div className="gx-banner-meta">
          <span className="gx-chip"><MapPin size={13} />{world.currentLocation}</span>
          <span className="gx-chip accent"><Dices size={13} />{PROFILE_LABELS[session.rulesProfile]}</span>
          <span className={`gx-chip ${live ? "live" : "muted"}`}>{live ? <Sparkles size={12} /> : <WifiOff size={12} />}{live ? "ИИ-мастер Gemini" : "Автономный режим"}</span>
        </div>
      </div>
    </div>

    {session.branchOrigin && <div className="gx-branch-note"><span className="gx-branch-icon"><GitBranch size={16} /></span><div><strong>Другой путь из истории «{session.branchOrigin.sessionTitle}»</strong><span>Точка «{session.branchOrigin.checkpointTitle}» · ход {session.branchOrigin.turn}. Дальше — ваши собственные решения.</span></div>{sessions.some((s) => s.id === session.branchOrigin?.sessionId) && <Link href={`/play/${session.branchOrigin.sessionId}`} className="text-link">Исходная история <ArrowRight size={13} /></Link>}</div>}

    <div className="gx-layout">
      <section className="gx-narrative">
        <header className="gx-narrative-head">
          <span className="gx-narrative-title"><BookOpen size={16} />Нить повествования</span>
          <span className={`gx-live ${live ? "on" : ""}`}><i />{live ? "Живой рассказчик" : "Офлайн-движок"}</span>
        </header>

        {!live && <div className="gx-offline"><Sparkles size={15} /><span>{session.campaignMode === "free" ? "Для продолжения свободной истории нужен ИИ-мастер." : "Сейчас историю ведёт упрощённый движок пресета."} <Link href="/settings">Подключить Gemini <ArrowRight size={12} /></Link></span></div>}

        {active && session.turnCount === 1 && <div className="gx-onboarding"><div className="gx-onboarding-head"><Sparkles size={16} /><strong>Начните своё приключение</strong></div><p>Опишите первое действие своими словами или выберите один из предложенных вариантов. Каждое решение меняет мир — сервер сохранит все последствия.</p><div className="gx-onboarding-examples">{["Осмотреться и изучить окружение", "Поговорить с ближайшим персонажем", "Проверить инвентарь и снаряжение"].map((example) => <button key={example} onClick={() => { setAction(example); composerRef.current?.focus(); }} disabled={busy}>{example}</button>)}</div><div className="gx-onboarding-foot">Совет: используйте клавишу «/» для быстрого перехода к полю ввода</div></div>}

        <div className="gx-feed">
          {turns[0]?.turnNumber > 1 && <button className="gx-load-earlier" onClick={() => void loadEarlier()} disabled={loadingOlder}>{loadingOlder ? <LoaderCircle size={14} className="spin" /> : <ChevronUp size={14} />}Предыдущие главы</button>}
          {turns.map((turn) => <article className={`gx-turn ${turn.role === "player" ? "is-player" : "is-narrator"}`} key={turn.id} id={`turn-${turn.turnNumber}${turn.role === "player" ? "-player" : ""}`}>
            <div className="gx-turn-head">
              <span className="gx-turn-avatar">{turn.role === "player" ? <UserRound size={15} /> : <Feather size={15} />}</span>
              <strong>{turn.role === "player" ? character.name : "Рассказчик"}</strong>
              <span className="gx-turn-no">Ход {turn.turnNumber}</span>
              {turn.role !== "player" && <span className="gx-turn-tag">{turn.modelUsed?.startsWith("gemini") ? "AI" : turn.modelUsed?.includes("intro") ? "Пролог" : "Офлайн"}</span>}
            </div>
            <div className="gx-prose">{turn.content}</div>
            {turn.dice && <div className={`gx-dice ${turn.dice.success ? "is-success" : "is-failure"} ${turn.dice.band === "cost" ? "is-cost" : ""}`}>
              <span className="gx-dice-value"><Dices size={18} /><strong>{turn.dice.total}</strong></span>
              <div className="gx-dice-body"><strong>{turn.dice.skill || turn.dice.label}</strong><small>{turn.dice.kind === "2d6" ? "Проверка риска · 2d6" : `Серверный d20 · сложность ${turn.dice.dc}`}</small></div>
              <span className="gx-dice-verdict">{turn.dice.band === "cost" ? "Успех с ценой" : turn.dice.success ? "Успех" : "Неудача"}</span>
            </div>}
            {turn.stateChanges && <AppliedChips applied={turn.stateChanges} />}
          </article>)}
          {busy && <div className="gx-thinking" aria-live="polite"><span className="gx-thinking-orb"><Sparkles size={18} /></span><div><strong>{TURN_STAGE_LABELS[turnRequest.stage]}</strong><small>Запрос сохранён. Перезагрузка страницы не создаст двойной ход.</small></div><span className="gx-thinking-dots"><i /><i /><i /></span></div>}
        </div>

        <div className="gx-composer-wrap" ref={actionZoneRef}>
          {turnRequest.pending && !busy && <div className="gx-recovery"><ShieldCheck size={19} /><div><strong>Ваше действие не потерялось</strong><p>«{turnRequest.pending.action}»</p><small>Повтор использует тот же requestId и сохранённый сервером бросок.</small><div className="gx-recovery-actions"><button className="button secondary" onClick={() => void turnRequest.retry()}><RefreshCw size={13} />Повторить безопасно</button><button className="text-button" onClick={turnRequest.dismiss}>Отложить действие</button></div></div></div>}

          {!active ? <div className="gx-archived"><span className="gx-archived-icon"><BookOpen size={22} /></span><div><strong>Эта история ждёт в архиве</strong><p>Прочитайте предыдущие главы или вернитесь к приключению.</p></div><button className="button primary" onClick={() => void restore()}>Продолжить историю <ArrowRight size={15} /></button></div> : <div className={`gx-composer ${canAct ? "is-ready" : ""}`}>
            <div className="gx-composer-head"><Sparkles size={16} /><h3>Что вы сделаете дальше?</h3></div>
            <p className="gx-composer-hint">{choices.length ? "Нажмите цифру, чтобы выбрать вариант, или клавишу «/», чтобы описать своё действие." : "Опишите действие своими словами — мир ответит на него."}</p>
            {lastNarrator?.choices?.length ? <div className="gx-choices">{lastNarrator.choices.map((choice, i) => <button className="gx-choice" key={`${i}-${choice}`} onClick={() => void act(choice)} disabled={busy} style={{ animationDelay: `${i * 55}ms` }}><span className="gx-choice-no">{selectedChoice === i ? <LoaderCircle size={14} className="spin" /> : i + 1}</span><p>{choice}</p><ArrowRight className="gx-choice-arrow" size={16} /></button>)}</div> : <p className="gx-free-note">Первое слово — за вами. Опишите действие, с которого начнётся история.</p>}
            <div className="gx-or"><span />или напишите своё<span /></div>
            <form onSubmit={submit} className="gx-input">
              <textarea ref={composerRef} id="action-input" aria-label="Ваше действие" placeholder="Я хочу… — опишите своё действие, и мир ответит" value={action} onChange={(e) => setAction(e.target.value)} maxLength={2000} rows={2} disabled={busy} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void act(action); } }} />
              <div className="gx-input-foot">
                <span className="gx-action-kind">{((turnRequest.pending?.action === action.trim() ? turnRequest.pending.custom : classifyAction(action, choices).custom)) ? "Свободное действие" : "Предложенное действие"}</span><span className="gx-counter">{action.length ? `${action.length} / 2000` : "Любое действие имеет значение"}</span>
                <div className="gx-input-cta"><span className="gx-hint"><CornerDownLeft size={12} />Ctrl + Enter</span><button className="button primary" disabled={busy || !action.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}Сделать ход</button></div>
              </div>
            </form>
            <div className="gx-composer-foot"><ShieldCheck size={13} />Модель предлагает — сервер проверяет каждое изменение мира.</div>
          </div>}

          {actionError && <div className="notice error-notice gx-error" role="alert"><ShieldCheck size={17} /><p>{actionError}{!live && session.campaignMode === "free" && <> <Link href="/settings">Открыть настройки</Link></>}</p></div>}
          {compactNeeded && <div className="notice gx-compact"><BrainCircuit size={18} /><p>Приключение стало длиннее. Сохраните последние главы в долгосрочной памяти.</p><button className="text-button" disabled={compacting} onClick={() => void compact()}>{compacting ? "Сохраняем…" : "Обобщить"}</button></div>}
        </div>
      </section>

      {!reading && <aside className="gx-sidebar">
        <div className="gx-tabs" role="tablist" aria-label="Состояние мира">{SIDE_TABS.map((tab, index) => <button role="tab" aria-selected={sideTab === tab.id} tabIndex={sideTab === tab.id ? 0 : -1} ref={(node) => { tabRefs.current[index] = node; }} onKeyDown={(event) => onTabKey(event, index)} key={tab.id} className={`gx-tab ${sideTab === tab.id ? "active" : ""}`} onClick={() => setSideTab(tab.id)}><tab.icon size={18} /><span>{tab.title}</span></button>)}</div>
        <div className="gx-side-scroll">
          {sideTab === "hero" && <div className="gx-side-section">
            <div className="gx-hero-id"><span className="gx-hero-avatar"><UserRound size={30} strokeWidth={1.4} /></span><div><h2>{character.name}</h2><p>{character.archetype}</p></div></div>
            <p className="gx-hero-story">{character.backstory}</p>
            {session.rulesProfile !== "narrative" && <div className="gx-vitals">
              <div className="gx-vital-head"><span><Heart size={14} />{session.rulesProfile === "d20" ? "Здоровье" : "Состояние"}</span><strong>{character.hp}<small> / {character.maxHp}</small></strong></div>
              <div className="gx-bar health"><i style={{ width: `${character.maxHp ? Math.max(0, Math.min(100, character.hp / character.maxHp * 100)) : 0}%` }} /></div>
              <div className="gx-vital-grid">{session.rulesProfile === "d20" && <div><small>Уровень</small><strong>{character.level}</strong></div>}<div><small>Средства</small><strong>{character.gold}</strong></div>{session.rulesProfile === "d20" && <div><small>Опыт</small><strong>{character.xp}</strong></div>}</div>
            </div>}
            {session.rulesProfile === "d20" && <div className="gx-stats">{Object.entries(character.stats).map(([key, value]) => <div key={key}><small>{key}</small><strong>{value}</strong></div>)}</div>}
            <div className="gx-side-title">Навыки и черты</div>
            <div className="gx-chips">{[...character.skills, ...character.traits].map((skill) => <span key={skill} className="gx-tag">{skill}</span>)}</div>
            {!!character.conditions?.length && <><div className="gx-side-title">Состояния</div><div className="gx-chips">{character.conditions.map((condition) => <span key={condition} className="gx-tag warn">{condition}</span>)}</div></>}
            <div className="gx-side-title"><Flag size={13} />Цели истории</div>
            {quests.map((quest) => <div className="gx-quest" key={quest.id}><div className="gx-quest-head"><span className={`gx-dot ${quest.status === "completed" ? "done" : quest.status === "failed" ? "fail" : ""}`} /><strong>{quest.title}</strong></div><div className="gx-quest-meta"><span>{quest.status === "completed" ? "Завершено" : quest.status === "failed" ? "Провалено" : quest.isMain ? "Главная цель" : "Побочная цель"}</span><span>{quest.progress}%</span></div><div className="gx-bar"><i style={{ width: `${quest.progress}%` }} /></div></div>)}
          </div>}
          {sideTab === "inventory" && <div className="gx-side-section">
            <div className="gx-side-title">С собой · {inventory.length}</div>
            <p className="gx-side-hint">Вещи — часть мира. Укажите предмет в своём действии, и рассказчик его учтёт.</p>
            <div className="gx-inv">{inventory.map((item) => <div className="gx-inv-item" key={item.id}><span className="gx-inv-icon">{item.icon}</span><div className="gx-inv-body"><h3>{item.name}{item.quantity > 1 && <span className="gx-inv-qty">×{item.quantity}</span>}</h3><p>{item.description}</p>{item.equipped && <small className="gx-inv-eq"><Check size={11} />Экипировано</small>}<button onClick={() => addItemToAction(item.name, item.id)} className="gx-inv-use" disabled={busy || !active}>Добавить в действие <Plus size={12} /></button></div></div>)}</div>
            {!inventory.length && <p className="gx-empty-hint">С собой пока ничего нет.</p>}
          </div>}
          {sideTab === "world" && <div className="gx-side-section">
            <div className="gx-here"><MapPin size={22} /><small>Вы находитесь здесь</small><h3>{world.currentLocation}</h3><p>{world.worldName}</p></div>
            {locations.length > 1 && <WorldMap locations={locations.filter((location) => location.discovered)} currentLocation={world.currentLocation} onLocationClick={(name) => { if (active && !busy) { setAction(`Отправиться в «${name}»`); composerRef.current?.focus(); } }} />}
            <div className="gx-side-title">Известные локации</div>
            <div className="gx-locs">{locations.filter((location) => location.discovered).map((location) => <div key={location.id} className={`gx-loc ${location.current ? "current" : ""}`}><Compass size={16} /><span><strong>{location.name}</strong><small>{location.description}</small></span>{location.current && <Check size={14} />}</div>)}</div>
            {!!sceneObjects.filter((o) => o.locationName === world.currentLocation).length && <><div className="gx-side-title">Окружение</div>{sceneObjects.filter((object) => object.locationName === world.currentLocation).map((object) => <div className="gx-scene" key={object.id}><div className="gx-scene-head"><strong>{object.name}</strong><span>{object.state}</span></div><p>{object.description}</p></div>)}</>}
            <div className="gx-side-title">Знакомые лица</div>
            {npcs.length ? npcs.map((npc) => <div className="gx-npc" key={npc.id}><span className="gx-npc-avatar"><UserRound size={18} /></span><div><strong>{npc.name}</strong><small>{npc.role || "—"} · {npc.status === "dead" ? "Погиб" : npc.relation > 0 ? "Расположен к вам" : npc.relation < 0 ? "Не доверяет" : "Нейтрален"}</small></div><span className={`gx-npc-rel ${npc.relation > 0 ? "pos" : npc.relation < 0 ? "neg" : ""}`}>{npc.relation > 0 ? "+" : ""}{npc.relation}</span></div>) : <p className="gx-side-hint">Новые знакомства ещё впереди.</p>}
          </div>}
          {sideTab === "memory" && <div className="gx-side-section">
            <div className="gx-side-title"><BrainCircuit size={14} />Мир помнит</div>
            <p className="gx-side-hint">Факты с подтверждённым источником помогают истории оставаться последовательной.</p>
            {memories.slice(0, 7).map((memory) => <div className="gx-mem" key={memory.id}><span className="gx-mem-src">{SOURCE_LABELS[memory.source]}</span><h3>{memory.title}</h3><p>{memory.content}</p></div>)}
            <Link href={`/memory?session=${sessionId}`} className="button secondary full-width gx-mem-all">Вся память мира <ArrowRight size={14} /></Link>
          </div>}
        </div>
        <div className="gx-side-foot"><ShieldCheck size={13} />Состояние подтверждено сервером</div>
      </aside>}
    </div>

    <footer className="gx-footer"><span><Compass size={14} />Это ваша история. Делайте её своей.</span><Link href="/blueprint">Chronicle Engine v2.5 <ArrowRight size={13} /></Link></footer>
    <p className="sr-only" role="status" aria-live="polite">{busy ? "Ход обрабатывается" : `Ход ${session.turnCount}. ${lastNarrator?.content.slice(0, 160) ?? ""}`}</p>
    {canAct && !actionVisible && <button className="gx-jump" onClick={() => { actionZoneRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); composerRef.current?.focus(); }}><ArrowDown size={17} />Ваш ход</button>}
    {showCheckpoints && <CheckpointDialog session={session} onClose={closeCheckpoints} />}
  </div>;
}

function AppliedChips({ applied }: { applied: AppliedChanges }) {
  const changes = [applied.location && `Локация: ${applied.location.to}`, applied.hp && `Здоровье ${applied.hp > 0 ? "+" : ""}${applied.hp}`, applied.xp && `Опыт +${applied.xp}`, applied.gold && `Средства ${applied.gold > 0 ? "+" : ""}${applied.gold}`, ...applied.inventory.filter((item) => item.ok).map((item) => `${item.op === "add" ? "+" : item.op === "consume" || item.op === "remove" ? "−" : ""} ${item.name} ×${item.quantity}`), ...applied.quests.map((quest) => `${quest.title}: ${quest.progress}%`), ...applied.conditions.added.map((condition) => `Состояние: ${condition}`)].filter(Boolean);
  return <>{!!changes.length && <div className="gx-applied">{changes.map((change, i) => <span key={i} className="gx-applied-chip"><Check size={11} />{change}</span>)}</div>}{!!applied.rejected.length && <details className="gx-rejected"><summary>Сервер не применил {applied.rejected.length} изменений</summary>{applied.rejected.map((reason, i) => <p key={i}>{reason}</p>)}</details>}</>;
}
