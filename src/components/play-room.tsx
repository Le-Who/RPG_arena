"use client";
import { buildNarrativeFeed } from "@/lib/narrative-feed";
import Link from "next/link";
import { createTurnHistory, mergeHistoryTurns } from "@/lib/turn-history";
import { memo, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type FormEvent } from "react";
import type React from "react";
import { findLast } from "@/lib/find-last";
import { ArrowDown, ArrowLeft, ArrowRight, Backpack, BookOpen, BookOpenText, Camera, Clock3, BrainCircuit, Check, ChevronUp, Compass, CornerDownLeft, Dices, Download, Feather, Flag, GitBranch, Globe2, Heart, LoaderCircle, MapPin, Minimize2, Plus, RefreshCw, Send, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { useApp } from "./app-shell";
import { api, jsonBody } from "@/lib/api-client";
import { canUseLiveNarrator, coverFor, PROFILE_LABELS, SOURCE_LABELS, type Snapshot } from "@/lib/ui-data";
import { AppliedChips } from "./applied-changes";
import type { TurnResponse } from "@/lib/turn-contract";
import { TURN_STAGE_LABELS } from "@/lib/turn-contract";
import { CampaignCopyButton } from "./campaign-copy-button";
import { CheckpointDialog } from "./checkpoint-dialog";
import { useTurnRequest } from "./use-turn-request";
import { classifyAction } from "@/lib/action-kind";
import { WorldMap } from "./world-map";
import { EntityActions } from "./entity-actions";
import { LifePanel } from "./life-panel";
import { ArcChronicle, ArcFinale } from "./arc-finale";
import { NpcBondDetails, PresenceStrip } from "./social-panel";
import { RecapCard } from "./recap-card";
import { recapLastTurnAt, shouldOfferRecap } from "@/lib/recap";
import { conditionExpiry, conditionRule, describeCure } from "@/lib/conditions";
import { formatClock } from "@/lib/world-life";
import { VisualGallery } from "./visual-gallery";
import { readLife, type StoryShapeKind } from "@/lib/world-life";
import type { InteractionState } from "@/lib/interactions";
import { retainedItemBindings, type ItemBinding } from "@/lib/item-bindings";
import { appendActionPhrase } from "@/lib/action-composer";
import { ActionEntityInput } from "./action-entity-input";
import { withCommittedTurn, applyCommittedSnapshot } from "@/lib/committed-turns";
import { useAppUpdateGuard } from "./app-update";
import { saveUpdateDraft, takeUpdateDraftWhenSafe, UPDATE_DRAFT_KEY } from "@/lib/update-draft";

const SIDE_TABS = [
  { id: "hero", icon: UserRound, title: "Герой" },
  { id: "inventory", icon: Backpack, title: "Вещи" },
  { id: "world", icon: Globe2, title: "Мир" },
  { id: "life", icon: Clock3, title: "Жизнь" },
  { id: "visuals", icon: Camera, title: "Образы" },
  { id: "memory", icon: BrainCircuit, title: "Память" },
] as const;

// NARR-4 (2.9): первые подсказки зависят от формы истории, а не только от приключенческого жанра.
const FIRST_ACTIONS: Record<StoryShapeKind, string[]> = {
  arc: ["Осмотреться и изучить окружение", "Поговорить с ближайшим персонажем", "Разузнать, что мешает цели"],
  "open-life": ["Оглядеться и решить, с чего начать день", "Написать или позвонить знакомому", "Заняться привычным делом"],
  scene: ["Осмотреться", "Заговорить с тем, кто рядом", "Сделать первый решительный шаг"],
};

function lastNarratorChoices(snapshot: Snapshot | null): string[] {
  if (!snapshot) return [];
  const last = findLast(snapshot.turns, (turn) => turn.role === "narrator");
  return last?.choices ?? [];
}

type FeedTurn = ReturnType<typeof buildNarrativeFeed>[number];

/** PERF-1 (2.9): лента мемоизирована — набор текста в поле действия не перерисовывает все ходы истории. */
const FeedTurns = memo(function FeedTurns({ turns, heroName }: { turns: FeedTurn[]; heroName: string }) {
  return <>
    {turns.map((turn) => <article className={`gx-turn ${turn.role === "player" ? "is-player" : "is-narrator"}`} key={turn.key} tabIndex={-1} aria-busy={turn.pending || undefined} id={`turn-${turn.turnNumber}${turn.role === "player" ? "-player" : ""}`}>
            <div className="gx-turn-head">
              <span className="gx-turn-avatar">{turn.role === "player" ? <UserRound size={15} /> : <Feather size={15} />}</span>
              <strong>{turn.role === "player" ? heroName : "Рассказчик"}</strong>
              <span className="gx-turn-no">Ход {turn.turnNumber}</span>
              {turn.role !== "player" && (turn.pending || turn.modelUsed?.includes("intro")) && <span className="gx-turn-tag">{turn.pending ? "Продолжение формируется" : "Пролог"}</span>}
            </div>
            <div className="gx-prose">{turn.content}</div>
            {turn.dice && <div className={`gx-dice ${turn.dice.success ? "is-success" : "is-failure"} ${turn.dice.band === "cost" ? "is-cost" : ""}`}>
              <span className="gx-dice-value"><Dices size={18} /><strong>{turn.dice.total}</strong></span>
              <div className="gx-dice-body"><strong>{turn.dice.skill || turn.dice.label}</strong><small>{turn.dice.kind === "2d6" ? "Проверка риска · 2d6" : `d20 · сложность ${turn.dice.dc}`}</small></div>
              <span className="gx-dice-verdict">{turn.dice.band === "cost" ? "Успех с ценой" : turn.dice.success ? "Успех" : "Неудача"}</span>
            </div>}
            {turn.stateChanges && <AppliedChips applied={turn.stateChanges} turnNumber={turn.turnNumber} />}
          </article>)}
  </>;
});

export function PlayRoom({ sessionId }: { sessionId: string }) {
  const { settings, sessions, refresh, notify, setPlayCommands, workspace, identity } = useApp();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [action, setAction] = useState("");
  const [itemBindings, setItemBindings] = useState<ItemBinding[]>([]);
  const [committedTurn, setCommittedTurn] = useState<TurnResponse | null>(null);
  const [syncError, setSyncError] = useState("");
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const closeCheckpoints = useCallback(() => setShowCheckpoints(false), []);
  const [sideTab, setSideTab] = useState<(typeof SIDE_TABS)[number]["id"]>("hero");
  const [reading, setReading] = useState(false);
  const [compactNeeded, setCompactNeeded] = useState(false);
  // NARR-9: резюме показывается автоматически после долгого перерыва и по команде.
  const [recapState, setRecapState] = useState<"auto" | "open" | "closed" | "idle">("idle");
  const [compacting, setCompacting] = useState(false);
  const compactingRef = useRef(false);
  const [restoredDraft, setRestoredDraft] = useState<string | null>(null);
  const [older, setOlder] = useState<Snapshot["turns"]>([]);
  const [historyRequests, setHistoryRequests] = useState(0);
  const loadingOlder = historyRequests > 0;
  const [pendingTarget, setPendingTarget] = useState<{ turnNumber: number } | null>(null);
  const navigation = useRef(0);
  const mounted = useRef(false);
  const history = useMemo(() => createTurnHistory<Snapshot["turns"][number]>({
    fetchPage: async (before, signal) => (await api<{ turns: Snapshot["turns"] }>(`/api/sessions/${sessionId}/turns?before=${before}`, { signal })).turns,
    onChange: setOlder,
  }), [sessionId]);
  useEffect(() => { history.setCurrent(snapshot?.session.id === sessionId ? snapshot.turns : []); }, [history, snapshot, sessionId]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; history.cancel(); };
  }, [history]);
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
    setSnapshot(old => old && old.session.turnCount > result.session.turnCount ? old : result);
    // Первая загрузка после перерыва ≥ 6 ч: предлагаем «Ранее в истории» один раз, без AI.
    setRecapState(state => state === "idle" ? (shouldOfferRecap({ turnCount: result.session.turnCount, updatedAt: recapLastTurnAt(result.turns, result.session.updatedAt) }) ? "auto" : "closed") : state);
    setCommittedTurn(old => old && result.session.turnCount < old.turnNumber ? old : null);
    setSyncError(""); setLoadError(""); return result;
  }, [sessionId]);
  const onCommitted = useCallback(async (result: TurnResponse) => {
    const suppressScroll = !!document.querySelector('[role="dialog"]');
    setCommittedTurn(result); setSnapshot(current => applyCommittedSnapshot(current, result)); setCompactNeeded(result.needsCompaction); setAction(""); setItemBindings([]); setSyncError(""); setRecapState("closed");
    const refreshStarted = performance.now();
    void reload().then(snapshot => {
      if (snapshot.session.turnCount < result.turnNumber) throw new Error("Состояние сцены ещё обновляется.");
      performance.measure("chronicle:turn:snapshot", { start: refreshStarted, detail: { requestId: result.requestId } });
      void refresh();
    }).catch(() => setSyncError(result.state ? "Ход сохранён. Дополнительные сведения пока не обновились; вы можете продолжать историю." : "Ход сохранён. Не удалось обновить состояние мира — обновите сцену перед следующим действием."));
    if (!suppressScroll) setTimeout(() => { if (!document.querySelector('[role="dialog"]')) document.getElementById(`turn-${result.turnNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }, 80);
  }, [reload, refresh]);
  const turnRequest = useTurnRequest(sessionId, onCommitted);
  const isUpdateSafe = turnRequest.isUpdateSafe;
  const draftReady = !!identity && restoredDraft === `${identity.profileId}:${sessionId}`;
  const busy = turnRequest.busy || (!!committedTurn && (!committedTurn.state || !snapshot || snapshot.session.turnCount < committedTurn.turnNumber));
  const updateContext = useAppUpdateGuard("play", {
    blocked: () => !snapshot || snapshot.session.id !== sessionId || !draftReady || busy || compacting || compactingRef.current || !turnRequest.isUpdateSafe() ? "Дождитесь завершения или восстановления хода и сохранения памяти перед обновлением." : null,
    prepare: () => {
      if (!action && itemBindings.length === 0) { try { sessionStorage.removeItem(UPDATE_DRAFT_KEY); } catch {} return; }
      if (!identity || snapshot?.isOwner !== true || snapshot.session.ownerId !== identity.profileId) throw new Error("Не удалось подтвердить владельца черновика. Скопируйте текст перед обновлением.");
      try { saveUpdateDraft(sessionStorage, { profileId: identity.profileId, campaignId: sessionId, action, itemBindings }); }
      catch { throw new Error("Хранилище вкладки недоступно. Скопируйте и очистите черновик перед обновлением."); }
    },
  });
  useEffect(() => {
    if (!identity || !snapshot || snapshot.session.id !== sessionId || !turnRequest.recoveryReady || turnRequest.pending || busy) return;
    const key = `${identity.profileId}:${sessionId}`;
    if (restoredDraft === key) return;
    // The pending request owns the composer until recovery finishes.
    const timer = setTimeout(() => {
      if (!isUpdateSafe()) return;
      if (snapshot.isOwner === true && snapshot.session.ownerId === identity.profileId) {
        try {
          const draft = takeUpdateDraftWhenSafe(sessionStorage, identity.profileId, sessionId, isUpdateSafe());
          if (draft) { setAction(draft.action); setItemBindings(draft.itemBindings); }
        } catch { /* No reload draft is available when storage is disabled. */ }
      }
      setRestoredDraft(key);
    }, 0);
    return () => clearTimeout(timer);
  }, [identity, snapshot, sessionId, isUpdateSafe, restoredDraft, turnRequest.recoveryReady, turnRequest.pending, busy]);
  const currentCommit = committedTurn && (!turnRequest.pending || turnRequest.pending.id === committedTurn.requestId);
  const actionError = turnRequest.error;
  useEffect(() => {
    if (!committedTurn || !currentCommit || turnRequest.startedAt === null) return;
    const started = turnRequest.startedAt;
    const frame = requestAnimationFrame(() => performance.measure("chronicle:turn:paint", { start: started, detail: { requestId: committedTurn.requestId } }));
    return () => cancelAnimationFrame(frame);
  }, [committedTurn, currentCommit, turnRequest.startedAt]);
  const sendTurn = turnRequest.send;
  useEffect(() => {
    if (!turnRequest.pending) return;
    const timer = window.setTimeout(() => setAction(turnRequest.pending?.action ?? ""), 0);
    return () => window.clearTimeout(timer);
  }, [turnRequest.pending]);

  // Nudge: when the action zone leaves the viewport, offer a way back to it.
  useEffect(() => {
    const node = actionZoneRef.current;
    if (!node) return;
    const io = new IntersectionObserver(([entry]) => setActionVisible(entry.isIntersecting), { rootMargin: "-40px 0px -80px 0px" });
    io.observe(node);
    return () => io.disconnect();
  }, [snapshot]);
  const act = useCallback(async (text: string) => {
    if (updateContext?.isReloading() || !draftReady) return;
    if (busy || !text.trim() || !snapshot || snapshot.isOwner === false) return;
    const pending = turnRequest.pending;
    const fresh = classifyAction(text, lastNarratorChoices(snapshot));
    const { action: submitted, custom, choice } = pending && pending.action === text.trim() ? { action: pending.action, custom: pending.custom, choice: -1 } : fresh;
    setSelectedChoice(choice);
    try { const ok = await sendTurn(submitted, custom, snapshot.session.turnCount, custom ? retainedItemBindings(submitted, itemBindings).map(i => i.id) : []); if (!ok) await reload().catch(() => {}); }
    finally { setSelectedChoice(-1); }
  }, [busy, reload, sendTurn, snapshot, turnRequest.pending, itemBindings, updateContext, draftReady]);
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
  const appendPhrase = (phrase: string, bindings: ItemBinding[] = []) => {
    if (!draftReady) return;
    const next = appendActionPhrase(action, phrase);
    if (next === null) { notify("В действии уже много текста. Освободите место перед добавлением фразы (лимит — 2000 символов).", true); return; }
    setAction(next);
    setItemBindings(old => [...new Map([...retainedItemBindings(next, old), ...bindings].map(item => [item.id, item])).values()].slice(0, 4));
    requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(next.length, next.length); });
  };
  const addItemToAction = (name: string, id: string) => appendPhrase(`Использовать «${name}»: `, [{ id, name }]);
  const loadEarlier = async () => {
    setHistoryRequests(count => count + 1);
    try { if (!(await history.loadEarlier())) notify("Более ранних ходов нет."); }
    catch (e) { if (mounted.current && !(e instanceof DOMException && e.name === "AbortError")) notify(e instanceof Error ? e.message : "Не удалось загрузить ходы", true); }
    finally { if (mounted.current) setHistoryRequests(count => Math.max(0, count - 1)); }
  };
  const jumpToTurn = useCallback(async (turnNumber: number) => {
    const request = ++navigation.current;
    setHistoryRequests(count => count + 1);
    try {
      const found = await history.ensureTurn(turnNumber);
      if (!mounted.current || request !== navigation.current) return;
      if (found) setPendingTarget({ turnNumber });
      else notify(`Ход ${turnNumber} не найден в сохранённой истории.`, true);
    } catch (e) {
      if (mounted.current && request === navigation.current) notify(e instanceof Error ? e.message : "Не удалось загрузить ходы", true);
    } finally { if (mounted.current) setHistoryRequests(count => Math.max(0, count - 1)); }
  }, [history, notify]);
  useEffect(() => {
    if (pendingTarget === null) return;
    const target = document.getElementById(`turn-${pendingTarget.turnNumber}`) ?? document.getElementById(`turn-${pendingTarget.turnNumber}-player`);
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start", behavior: workspace.reading.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    } else notify(`Ход ${pendingTarget.turnNumber} не найден в ленте.`, true);
  }, [pendingTarget, workspace.reading.motion, notify]);
  useEffect(() => {
    const listener = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(".gx-room a[href^='#turn-']") : null;
      const match = anchor?.getAttribute("href")?.match(/^#turn-(\d+)(?:-player)?$/);
      if (!match) return;
      event.preventDefault();
      void jumpToTurn(Number(match[1]));
    };
    document.addEventListener("click", listener);
    return () => document.removeEventListener("click", listener);
  }, [jumpToTurn]);
  const initialHistoryLink = useRef<string | null>(null);
  const jumpToInitialLink = useEffectEvent(() => {
    if (initialHistoryLink.current === sessionId) return;
    initialHistoryLink.current = sessionId;
    const match = window.location.hash.match(/^#turn-(\d+)(?:-player)?$/);
    if (match) void jumpToTurn(Number(match[1]));
  });
  useEffect(() => {
    let active = true;
    api<Snapshot>(`/api/sessions/${sessionId}?memories=8`).then((result) => {
      if (!active) return; history.setCurrent(result.turns); jumpToInitialLink(); setSnapshot(old => old && old.session.turnCount > result.session.turnCount ? old : result);
      setRecapState(state => state === "idle" ? (!window.location.hash && shouldOfferRecap({ turnCount: result.session.turnCount, updatedAt: recapLastTurnAt(result.turns, result.session.updatedAt) }) ? "auto" : "closed") : state);
    }).catch((e) => { if (active) setLoadError(e.message); });
    return () => { active = false; };
  }, [sessionId, history]);
  const compact = useCallback(async () => { if (updateContext?.isReloading()) return; compactingRef.current = true; setCompacting(true); try { await api(`/api/sessions/${sessionId}/compact`, jsonBody({})); await reload(); setCompactNeeded(false); notify("Новые главы сохранены в долгосрочной памяти"); } catch (e) { notify(e instanceof Error ? e.message : "Не удалось сохранить память", true); } finally { compactingRef.current = false; setCompacting(false); } }, [sessionId, reload, notify, updateContext]);
  const commandOwner = snapshot?.isOwner !== false;
  const commandReady = !!snapshot && !loadError;
  const commandActive = snapshot?.session.status === "active";
  const commandTurn = snapshot?.session.turnCount;
  useEffect(() => {
    if (!commandReady) { setPlayCommands([]); return; }
    const commands = [
      { id: "reading", label: "Переключить режим чтения", run: () => setReading(value => !value) },
      { id: "recap", label: "Ранее в истории", run: () => { setRecapState("open"); setTimeout(() => document.getElementById("recap-title")?.scrollIntoView({ block: "start", behavior: "smooth" }), 60); } },
      { id: "first", label: "К началу истории", run: () => { void jumpToTurn(1); } },
      { id: "life", label: "Жизнь мира: время, события, договорённости", run: () => { setReading(false); setSideTab("life"); } },
      { id: "people", label: "Люди: распорядок, связи и знания", run: () => { setReading(false); setSideTab("world"); } },
      { id: "book", label: "Скачать книгу для чтения офлайн (HTML)", run: () => { const link = document.createElement("a"); link.href = `/api/sessions/${sessionId}/export?format=html`; link.rel = "noopener"; link.click(); } },
      { id: "jump-turn", label: "Перейти к ходу… (введите «ход 12»)", run: () => { void jumpToTurn(1); }, jumpToTurn: (turn: number) => { void jumpToTurn(turn); }, maxTurn: commandTurn ?? 1 },
      { id: "latest", label: "К последнему ходу", run: () => document.getElementById(`turn-${commandTurn}`)?.scrollIntoView({ block: "start", behavior: workspace.reading.motion === "reduced" ? "instant" : "smooth" }) },
      ...(commandOwner && !busy && !compacting ? [{ id: "checkpoints", label: "Контрольные точки и ветки", run: () => setShowCheckpoints(true) }] : []),
      ...(commandOwner && commandActive && !busy && !compacting ? [{ id: "compact", label: "Сохранить главы в память", run: () => { void compact(); } }] : []),
    ];
    setPlayCommands(commands);
    return () => setPlayCommands([]);
  }, [commandReady, commandOwner, commandActive, commandTurn, busy, compacting, compact, setPlayCommands, workspace.reading.motion, sessionId, jumpToTurn]);
  const restore = async () => { try { await api(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }); await reload(); void refresh(); } catch (e) { notify(e instanceof Error ? e.message : "Ошибка", true); } };

  const feedTurns = useMemo(() => snapshot ? buildNarrativeFeed(withCommittedTurn(mergeHistoryTurns(older, snapshot.turns), committedTurn, sessionId), turnRequest.pending, turnRequest.preview) : [],
    [snapshot, older, committedTurn, sessionId, turnRequest.pending, turnRequest.preview]);
  const discoveredLocations = useMemo(() => snapshot?.locations.filter(location => location.discovered) ?? [], [snapshot?.locations]);
  const snapshotSceneObjects = snapshot?.sceneObjects;
  const snapshotCurrentLocation = snapshot?.session.worldState.currentLocation;
  const currentLocationObjects = useMemo(() => snapshotSceneObjects?.filter(object => object.locationName === snapshotCurrentLocation) ?? [],
    [snapshotSceneObjects, snapshotCurrentLocation]);
  if (loadError) return <div className="empty-state gx-fallback"><BookOpen size={34} /><h3>Не удалось открыть эту главу</h3><p>{loadError}</p><button className="button secondary" onClick={() => void reload().catch((e) => setLoadError(e.message))}><RefreshCw size={15} />Попробовать снова</button><Link className="text-link" href="/campaigns">Вернуться к кампаниям</Link></div>;
  if (!snapshot) return <div className="gx-loading"><span className="gx-loading-orb"><LoaderCircle size={30} className="spin" /></span><h2>Открываем вашу историю…</h2><p>Загружаем мир, персонажей и сохранённые решения.</p></div>;

  const { session, inventory, memories, locations, quests, npcs, sceneObjects } = snapshot;
  const character = session.character;
  const world = session.worldState;
  const live = canUseLiveNarrator(settings);
  const turns = feedTurns;
  const lastNarrator = findLast(snapshot.turns, (turn) => turn.role === "narrator");
  const isOwner = snapshot.isOwner !== false;
  const active = isOwner && session.status === "active";
  // INTERACT-1: то же состояние, по которому сервер проверяет доступность действий.
  const interactionState: InteractionState = { currentLocation: world.currentLocation, inventory, npcs, sceneObjects, locations, holdings: readLife(world).holdings };
  const pickAction = (text: string, itemIds: string[]) => {
    if (!active || busy) return;
    appendPhrase(text, itemIds.flatMap((id) => { const item = inventory.find((i) => i.id === id); return item ? [{ id, name: item.name }] : []; }));
  };
  const actionsDisabled = busy || !!committedTurn || !active || !draftReady;
  const canAct = active && !busy && draftReady;

  return <div className={`gx-room ${reading ? "gx-reading" : ""}`}>
    <div className="gx-topbar">
      <Link href="/campaigns" className="gx-back"><ArrowLeft size={16} /><span>Мои кампании</span></Link>
      <div className="gx-topbar-title"><MapPin size={13} />{world.currentLocation}</div>
      <div className="gx-topbar-actions">
        <span className={`gx-save ${busy ? "is-busy" : ""}`}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}<span>{busy ? "Ход в обработке" : "Сохранено"}</span></span>
        <button className="gx-tool" aria-label="Развилки истории" title="Развилки истории" onClick={() => setShowCheckpoints(true)} disabled={!isOwner || busy}><GitBranch size={16} /><span>Развилки</span></button>
        <a className="gx-tool icon-only" href={`/api/sessions/${sessionId}/export`} title="Скачать историю" aria-label="Скачать историю"><Download size={16} /></a>
        <a className="gx-tool icon-only" href={`/api/sessions/${sessionId}/export?format=html`} title="Книга для чтения офлайн (HTML)" aria-label="Скачать книгу для чтения офлайн"><BookOpen size={16} /></a>
        {isOwner && <a className="gx-tool" href={`/api/sessions/${sessionId}/export?format=json`} title="Переносимая копия кампании" aria-label="Скачать кампанию JSON">JSON</a>}
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
        </div>
      </div>
    </div>

    {session.branchOrigin && <div className="gx-branch-note"><span className="gx-branch-icon"><GitBranch size={16} /></span><div><strong>Другой путь из истории «{session.branchOrigin.sessionTitle}»</strong><span>Точка «{session.branchOrigin.checkpointTitle}» · ход {session.branchOrigin.turn}. Дальше — ваши собственные решения.</span></div>{sessions.some((s) => s.id === session.branchOrigin?.sessionId) && <Link href={`/play/${session.branchOrigin.sessionId}`} className="text-link">Исходная история <ArrowRight size={13} /></Link>}</div>}

    <div className="gx-layout">
      <section className="gx-narrative">
        <header className="gx-narrative-head">
          <span className="gx-narrative-title"><BookOpen size={16} />Нить повествования</span>
        </header>

        {!live && <div className="gx-offline"><Sparkles size={15} /><span>{session.campaignMode === "free" ? "Чтобы продолжить эту историю, подключите рассказчика в настройках." : "В базовом режиме продолжения ограничены готовыми правилами сценария."} <Link href="/settings">Подключить рассказчика <ArrowRight size={12} /></Link></span></div>}

        {active && session.turnCount === 1 && <div className="gx-onboarding"><div className="gx-onboarding-head"><Sparkles size={16} /><strong>{readLife(world).story.kind === "open-life" ? "Начните свою историю" : "Начните своё приключение"}</strong></div><p>Опишите первое действие своими словами или выберите один из предложенных вариантов.</p><div className="gx-onboarding-examples">{FIRST_ACTIONS[readLife(world).story.kind].map((example) => <button key={example} onClick={() => { appendPhrase(example); }} disabled={busy}>{example}</button>)}</div><div className="gx-onboarding-foot">Совет: используйте клавишу «/» для быстрого перехода к полю ввода</div></div>}

        <div className="gx-feed">
          {(recapState === "open" || recapState === "auto") && <RecapCard sessionId={sessionId} onClose={() => setRecapState("closed")} onNotify={notify} />}
          {turns[0]?.turnNumber > 1 && <button className="gx-load-earlier" onClick={() => void loadEarlier()} disabled={loadingOlder}>{loadingOlder ? <LoaderCircle size={14} className="spin" /> : <ChevronUp size={14} />}Предыдущие главы</button>}
          <FeedTurns turns={turns} heroName={character.name} />
          <ArcFinale sessionId={sessionId} world={world} turnCount={session.turnCount} canEdit={isOwner} disabled={busy || compacting} onSaved={() => { void reload().catch(() => {}); }} onBranch={() => setShowCheckpoints(true)} />
          <ArcChronicle world={world} />
          {syncError && <div className="notice" role="alert"><p>{syncError}</p><button className="text-button" onClick={() => void reload().catch(() => setSyncError("Связь пока не восстановлена. Ход сохранён; попробуйте обновить сцену ещё раз."))}>Обновить сцену</button></div>}
          {busy && <div className="gx-thinking" aria-live="polite"><span className="gx-thinking-orb"><Sparkles size={18} /></span><div><strong>{currentCommit ? "Ход сохранён · обновляем мир" : TURN_STAGE_LABELS[turnRequest.stage]}</strong><small>Запрос сохранён. Перезагрузка страницы не создаст двойной ход.</small></div><span className="gx-thinking-dots"><i /><i /><i /></span></div>}
        </div>

        <div className="gx-composer-wrap" ref={actionZoneRef}>
          {turnRequest.pending && !busy && <div className="gx-recovery"><ShieldCheck size={19} /><div><strong>Ваше действие не потерялось</strong><p>«{turnRequest.pending.action}»</p><small>Безопасный повтор проверит результат предыдущей попытки и не создаст второй ход.</small><div className="gx-recovery-actions"><button className="button secondary" onClick={() => void turnRequest.retry()}><RefreshCw size={13} />Повторить безопасно</button><button className="text-button" onClick={turnRequest.dismiss}>Отложить действие</button></div></div></div>}

          {!isOwner ? <div className="notice"><BookOpen size={18} /><div><p>Вы читаете общую кампанию. Создайте свою приватную копию, чтобы играть со своим прогрессом и своим API-ключом.</p><CampaignCopyButton sessionId={sessionId} /></div></div> : !active ? <div className="gx-archived"><span className="gx-archived-icon"><BookOpen size={22} /></span><div><strong>Эта история ждёт в архиве</strong><p>Прочитайте предыдущие главы или вернитесь к приключению.</p></div><button className="button primary" onClick={() => void restore()}>Продолжить историю <ArrowRight size={15} /></button></div> : <div className={`gx-composer ${canAct ? "is-ready" : ""}`}>
            <div className="gx-composer-head"><Sparkles size={16} /><h3>Что вы сделаете дальше?</h3></div>
            <p className="gx-composer-hint">{choices.length ? "Нажмите цифру, чтобы выбрать вариант, или клавишу «/», чтобы описать своё действие." : "Опишите действие своими словами — мир ответит на него."}</p>
            {lastNarrator?.choices?.length ? <div className="gx-choices">{lastNarrator.choices.map((choice, i) => <button className="gx-choice" key={`${i}-${choice}`} onClick={() => void act(choice)} disabled={busy} style={{ animationDelay: `${i * 55}ms` }}><span className="gx-choice-no">{selectedChoice === i ? <LoaderCircle size={14} className="spin" /> : i + 1}</span><p>{choice}</p><ArrowRight className="gx-choice-arrow" size={16} /></button>)}</div> : <p className="gx-free-note">Первое слово — за вами. Опишите действие, с которого начнётся история.</p>}
            <div className="gx-or"><span />или напишите своё<span /></div>
            <form onSubmit={submit} className="gx-input">
              <ActionEntityInput inputRef={composerRef} value={action} state={interactionState} disabled={busy || !draftReady} onChange={text => { setAction(text); setItemBindings(old => retainedItemBindings(text, old)); }} onItemPick={(id, name) => setItemBindings(old => [...new Map([...old, { id, name }].map(item => [item.id, item])).values()].slice(0, 4))} onSubmit={() => { void act(action); }} onLimit={() => notify("Подсказка не помещается в действие. Лимит — 2000 символов.", true)} />
              <div className="gx-input-foot">
                <span className="gx-action-kind">{((turnRequest.pending?.action === action.trim() ? turnRequest.pending.custom : classifyAction(action, choices).custom)) ? "Свободное действие" : "Предложенное действие"}</span><span className="gx-counter">{action.length ? `${action.length} / 2000` : "Любое действие имеет значение"}</span>
                <div className="gx-input-cta"><span className="gx-hint"><CornerDownLeft size={12} />Ctrl + Enter</span><button className="button primary" disabled={busy || !draftReady || !action.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}Сделать ход</button></div>
              </div>
            </form>
          </div>}

          {actionError && <div className="notice error-notice gx-error" role="alert"><ShieldCheck size={17} /><p>{actionError}{!live && session.campaignMode === "free" && <> <Link href="/settings">Открыть настройки</Link></>}</p></div>}
          {isOwner && compactNeeded && <div className="notice gx-compact"><BrainCircuit size={18} /><p>Приключение стало длиннее. Сохраните последние главы в долгосрочной памяти.</p><button className="text-button" disabled={compacting} onClick={() => void compact()}>{compacting ? "Сохраняем…" : "Обобщить"}</button></div>}
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
            {!!character.conditions?.length && <><div className="gx-side-title">Состояния</div><div className="gx-chips">{character.conditions.map((condition) => { const rule = session.rulesProfile === "narrative" ? null : conditionRule(condition); const until = conditionExpiry(world, condition); return <span key={condition} className="gx-tag warn" title={rule ? `${rule.label}: ${rule.modifier > 0 ? "+" : ""}${rule.modifier}. ${rule.note} Снимается: ${describeCure(rule)}.${until ? ` Пройдёт к ${formatClock(until)}.` : ""}` : until ? `Пройдёт к ${formatClock(until)}.` : "Описательное состояние без модификатора"}>{condition}{rule && <small> {rule.modifier > 0 ? "+" : ""}{rule.modifier}</small>}</span>; })}</div></>}
            <div className="gx-side-title"><Flag size={13} />Цели истории</div>
            {quests.map((quest) => <div className="gx-quest" key={quest.id}><div className="gx-quest-head"><span className={`gx-dot ${quest.status === "completed" ? "done" : quest.status === "failed" ? "fail" : ""}`} /><strong>{quest.title}</strong></div><div className="gx-quest-meta"><span>{quest.status === "completed" ? "Завершено" : quest.status === "failed" ? "Провалено" : quest.isMain ? "Главная цель" : "Побочная цель"}</span><span>{quest.progress}%</span></div><div className="gx-bar"><i style={{ width: `${quest.progress}%` }} /></div></div>)}
          </div>}
          {sideTab === "inventory" && <div className="gx-side-section">
            <div className="gx-side-title">С собой · {inventory.length}</div>
            <p className="gx-side-hint">Вещи — часть мира. Укажите предмет в своём действии, и рассказчик его учтёт.</p>
            {!!committedTurn && <p className="gx-side-hint" role="status">Список вещей обновляется. Продолжить историю можно в поле действия.</p>}
            <div className="gx-inv">{inventory.map((item) => <div className="gx-inv-item" key={item.id}><span className="gx-inv-icon">{item.icon}</span><div className="gx-inv-body"><h3>{item.name}{item.quantity > 1 && <span className="gx-inv-qty">×{item.quantity}</span>}</h3><p>{item.description}</p>{item.equipped && <small className="gx-inv-eq"><Check size={11} />Экипировано</small>}<button onClick={() => addItemToAction(item.name, item.id)} className="gx-inv-use" disabled={actionsDisabled}>Добавить в действие <Plus size={12} /></button><EntityActions kind="item" refId={item.id} name={item.name} state={interactionState} disabled={actionsDisabled} onPick={pickAction} /></div></div>)}</div>
            {!inventory.length && <p className="gx-empty-hint">С собой пока ничего нет.</p>}
          </div>}
          {sideTab === "world" && <div className="gx-side-section">
            <div className="gx-here"><MapPin size={22} /><small>Вы находитесь здесь</small><h3>{world.currentLocation}</h3><p>{world.worldName}</p></div>
            {locations.length > 0 && <WorldMap locations={discoveredLocations} currentLocation={world.currentLocation} onLocationClick={(name) => { if (active && !busy) { appendPhrase(`Отправиться в «${name}»`); } }} />}
            <div className="gx-side-title">Известные локации</div>
            <div className="gx-locs">{discoveredLocations.map((location) => <div key={location.id} className={`gx-loc ${location.current ? "current" : ""}`}><Compass size={16} /><span><strong>{location.name}</strong><small>{location.description}</small>{!location.current && <EntityActions kind="location" refId={location.id} name={location.name} state={interactionState} disabled={actionsDisabled} onPick={pickAction} />}</span>{location.current && <Check size={14} />}</div>)}</div>
            {!!currentLocationObjects.length && <><div className="gx-side-title">Окружение</div>{currentLocationObjects.map((object) => <div className="gx-scene" key={object.id}><div className="gx-scene-head"><strong>{object.name}</strong><span>{object.state}</span></div><p>{object.description}</p><EntityActions kind="object" refId={object.key} name={object.name} state={interactionState} disabled={actionsDisabled} onPick={pickAction} /></div>)}</>}
            <PresenceStrip world={world} npcs={npcs} />
            <div className="gx-side-title">Знакомые лица</div>
            {npcs.length ? npcs.map((npc) => <div className="gx-npc" key={npc.id}><span className="gx-npc-avatar"><UserRound size={18} /></span><div><strong>{npc.name}</strong><small>{npc.role || "—"} · {npc.status === "dead" ? "Погиб" : npc.relation > 0 ? "Расположен к вам" : npc.relation < 0 ? "Не доверяет" : "Нейтрален"}</small></div><span className={`gx-npc-rel ${npc.relation > 0 ? "pos" : npc.relation < 0 ? "neg" : ""}`}>{npc.relation > 0 ? "+" : ""}{npc.relation}</span>{npc.status !== "dead" && <div className="lx-npc-actions"><EntityActions kind="npc" refId={npc.key} name={npc.name} state={interactionState} disabled={actionsDisabled} onPick={pickAction} /></div>}<NpcBondDetails world={world} npcKey={npc.key} sessionId={sessionId} canEdit={isOwner} disabled={actionsDisabled} onSaved={() => { void reload().catch(() => {}); }} /></div>) : <p className="gx-side-hint">Новые знакомства ещё впереди.</p>}
          </div>}
          {sideTab === "life" && <LifePanel sessionId={sessionId} world={world} canEdit={isOwner} disabled={actionsDisabled} interactionState={interactionState} onPick={pickAction} onSaved={() => { void reload().catch(() => {}); }} />}
          {sideTab === "visuals" && <VisualGallery sessionId={sessionId} isOwner={isOwner} npcs={npcs.filter((npc) => npc.status !== "dead").map((npc) => ({ key: npc.key, name: npc.name }))} currentLocationId={locations.find((location) => location.current)?.id ?? null} lastTurn={session.turnCount} />}
          {sideTab === "memory" && <div className="gx-side-section">
            <div className="gx-side-title"><BrainCircuit size={14} />Мир помнит</div>
            {memories.slice(0, 7).map((memory) => <div className="gx-mem" key={memory.id}><span className="gx-mem-src">{SOURCE_LABELS[memory.source]}</span><h3>{memory.title}</h3><p>{memory.content}</p></div>)}
            <Link href={`/memory?session=${sessionId}`} className="button secondary full-width gx-mem-all">Вся память мира <ArrowRight size={14} /></Link>
          </div>}
        </div>
      </aside>}
    </div>

    <footer className="gx-footer"><Link href="/blueprint">Chronicle Engine <ArrowRight size={13} /></Link></footer>
    <p className="sr-only" role="status" aria-live="polite">{busy ? "Ход обрабатывается" : `Ход ${session.turnCount}. ${lastNarrator?.content.slice(0, 160) ?? ""}`}</p>
    {canAct && !actionVisible && <button className="gx-jump" onClick={() => { actionZoneRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); composerRef.current?.focus(); }}><ArrowDown size={17} />Ваш ход</button>}
    {isOwner && showCheckpoints && <CheckpointDialog session={session} onClose={closeCheckpoints} />}
  </div>;
}
