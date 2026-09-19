"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, BookOpen, BrainCircuit, Check, Database, Download, Fingerprint, Layers3, LoaderCircle, RefreshCw, Search, ShieldCheck, Sparkles } from "lucide-react";
import { useApp } from "./app-shell";
import { api, jsonBody } from "@/lib/api-client";
import { SOURCE_LABELS, coverFor, type Snapshot } from "@/lib/ui-data";
import type { RetrievedNode } from "@/lib/embeddings";
const layers = [{ id: "", title: "Все слои" }, { id: "semantic", title: "Факты" }, { id: "episodic", title: "События" }, { id: "procedural", title: "Правила" }, { id: "chronicle", title: "Хроника" }];
export function StoryRecords({ mode }: { mode: "memory" | "journal" }) {
  const { sessions, settings, newStory, notify, loading } = useApp();
  const [requestedSession] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("session") ?? "");
  const [chosenSessionId, setChosenSessionId] = useState("");
  const sessionId = sessions.some((session) => session.id === chosenSessionId)
    ? chosenSessionId
    : sessions.find((session) => session.id === requestedSession)?.id ?? sessions[0]?.id ?? "";
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [layer, setLayer] = useState("");
  const [searching, setSearching] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [results, setResults] = useState<RetrievedNode[] | null>(null);
  const [timing, setTiming] = useState(0);
  const searchRequest = useRef(0);
  const hasKey = Boolean(settings && settings.keysCount + settings.envKeysCount > 0);
  const load = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true); setError("");
    try { setSnapshot(await api<Snapshot>(`/api/sessions/${sessionId}`)); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось загрузить память"); }
    finally { setBusy(false); }
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    searchRequest.current++;
    api<Snapshot>(`/api/sessions/${sessionId}`).then((data) => { if (active) setSnapshot(data); }).catch((e) => { if (active) setError(e.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [sessionId]);
  const chooseSession = (nextSessionId: string) => {
    searchRequest.current++;
    setChosenSessionId(nextSessionId);
    setSearching(false);
    setBusy(true);
    setError("");
    setSnapshot(null);
    setResults(null);
    setQuery("");
  };
  const semanticSearch = async () => {
    if (!query.trim() || searching) return;
    const request = ++searchRequest.current;
    setSearching(true); setError("");
    try { const result = await api<{ results: RetrievedNode[]; ms: number }>(`/api/sessions/${sessionId}/memory/search?q=${encodeURIComponent(query)}`); if (request === searchRequest.current) { setResults(result.results); setTiming(result.ms); } }
    catch (e) { if (request === searchRequest.current) setError(e instanceof Error ? e.message : "Поиск не удался"); } finally { if (request === searchRequest.current) setSearching(false); }
  };
  const reindex = async () => {
    setIndexing(true);
    try { const result = await api<{ indexed: number; failed: number; pending: number; indexing?: { indexed: number } }>(`/api/sessions/${sessionId}/memory/reindex`, jsonBody({})); await load(); notify(`Индекс обновлён. Готово к поиску: ${result.indexed ?? result.indexing?.indexed ?? 0} новых фактов.`); }
    catch (e) { notify(e instanceof Error ? e.message : "Ошибка индексации", true); } finally { setIndexing(false); }
  };
  const memories = (results ?? snapshot?.memories ?? []).filter((node) => (!layer || node.layer === layer) && (results !== null || `${node.title} ${node.content}`.toLowerCase().includes(query.toLowerCase())));
  const turns = snapshot?.turns.filter((turn) => !query || turn.content.toLowerCase().includes(query.toLowerCase())) ?? [];
  if (!loading && !sessions.length) return <div className="empty-state"><BrainCircuit size={32} /><h3>У этой истории ещё нет воспоминаний</h3><p>Начните первую кампанию. Мы сохраним её мир, героя и каждый сделанный выбор.</p><button className="button primary" onClick={() => newStory()}>Начать историю <ArrowRight size={14} /></button></div>;
  return <section className="records"><div className="records-toolbar"><div className="record-select"><BookOpen size={17} /><select aria-label="Выбрать кампанию" disabled={indexing} value={sessionId} onChange={(e) => chooseSession(e.target.value)}>{sessions.map((s) => <option key={s.id} value={s.id}>{s.title} · {s.character.name}</option>)}</select></div><div className="record-actions">{mode === "memory" ? <button className="button secondary" onClick={() => void reindex()} disabled={!hasKey || !settings?.embeddingsEnabled || indexing || !snapshot} title={!hasKey ? "Добавьте ключ Gemini в настройках" : "Переиндексировать память"}>{indexing ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Обновить индекс</button> : <a className="button secondary" href={`/api/sessions/${sessionId}/export`}><Download size={14} />Скачать историю</a>}<Link className="button primary" href={`/play/${sessionId}`}>Продолжить <ArrowRight size={14} /></Link></div></div>
    {error && <div className="notice error-notice" role="alert"><ShieldCheck size={17} /><p>{error}</p><button className="text-button" onClick={() => void load()}>Повторить</button></div>}
    {mode === "memory" && snapshot && <><div className="memory-metrics"><div><span className="feature-icon violet"><Database size={19} /></span><section><small>ФАКТОВ В ПАМЯТИ</small><strong>{snapshot.embeddings?.nodes ?? snapshot.memories.length}<span>сохранено в каноне</span></strong></section></div><div><span className="feature-icon teal"><BrainCircuit size={19} /></span><section><small>СЕМАНТИЧЕСКИЙ ИНДЕКС</small><strong>{snapshot.embeddings?.ready ?? 0}<span>готово к поиску</span></strong></section></div><div><span className="feature-icon amber"><Layers3 size={19} /></span><section><small>МОДЕЛЬ ПАМЯТИ</small><strong className="model-metric">gemini-embedding-2<span>{settings?.embeddingDims ?? 768} измерений · отдельное пространство кампании</span></strong></section></div></div>{!hasKey && <div className="notice"><Sparkles size={17} /><p>Канон и события уже сохраняются в PostgreSQL. <Link href="/settings">Подключите Gemini</Link>, чтобы искать воспоминания по смыслу, а не только по словам.</p></div>}</>}
    <div className="memory-search-row"><label className="search-field large"><Search size={17} /><input placeholder={mode === "memory" ? "Что вы хотите вспомнить?" : "Найти момент в истории…"} value={query} onChange={(e) => { searchRequest.current++; setSearching(false); setQuery(e.target.value); setResults(null); }} onKeyDown={(e) => { if (e.key === "Enter" && hasKey && mode === "memory") void semanticSearch(); }} aria-label="Поиск по истории" /></label>{mode === "memory" && <button className="button secondary" onClick={() => void semanticSearch()} disabled={!hasKey || !settings?.embeddingsEnabled || !query.trim() || searching}>{searching ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}Поиск по смыслу</button>}</div>
    {mode === "memory" && <div className="records-filter-row"><div className="category-tabs">{layers.map((l) => <button key={l.title} className={layer === l.id ? "selected" : ""} onClick={() => setLayer(l.id)}>{l.title}</button>)}</div><span className="search-mode">{results !== null ? `Семантический поиск · ${timing} мс` : query ? "Фильтр по тексту" : "Каноническая память"}</span></div>}
    {busy ? <div className="skeleton-panel" /> : mode === "memory" ? <div className="memory-grid">{memories.map((node) => <article className="memory-card" key={node.id}><div className="memory-card-meta"><span><Fingerprint size={12} />{layers.find((l) => l.id === node.layer)?.title ?? node.layer}</span><span className={`source-label ${node.source === "state" ? "confirmed" : ""}`}>{node.source === "state" && <ShieldCheck size={11} />}{SOURCE_LABELS[node.source] ?? node.source}</span></div><h3>{node.title}</h3><p>{node.content}</p>{"why" in node && <div className="similarity-label"><BrainCircuit size={12} />{String(node.why)}</div>}{node.evidence && <blockquote>«{node.evidence}»</blockquote>}<div className="memory-card-bottom"><span>Важность <strong>{Math.round(node.importance)}%</strong></span><Link href={`/play/${sessionId}#turn-${node.sourceTurn ?? node.turnTo ?? 1}`}>К исходному ходу <ArrowRight size={12} /></Link></div></article>)}</div> : <><div className="journal-heading"><span><BookOpen size={14} />{snapshot?.session.title}</span><small>Последние {snapshot?.turns.length ?? 0} записей · полный журнал доступен в экспорте</small></div><div className="journal-list">{turns.map((turn) => <article className={`journal-entry ${turn.role === "player" ? "player" : ""}`} key={turn.id}><div className="journal-marker">{turn.role === "player" ? <Fingerprint size={16} /> : <FeatherIcon />}</div><div className="journal-entry-body"><div className="turn-label"><strong>{turn.role === "player" ? snapshot?.session.character.name : "Рассказчик"}</strong><span>Ход {turn.turnNumber}</span><Link href={`/play/${sessionId}#turn-${turn.turnNumber}`}><ArrowRight size={12} /></Link></div><p>{turn.content}</p></div></article>)}</div></>}
    {!busy && snapshot && (mode === "memory" ? !memories.length : !turns.length) && <div className="empty-state"><Search size={27} /><h3>Пока ничего не найдено</h3><p>{results !== null ? "Индекс может быть ещё не готов. Обновите его или уточните запрос." : "Попробуйте изменить запрос или выбрать другой слой памяти."}</p><button className="button secondary" onClick={() => { setQuery(""); setLayer(""); setResults(null); }}>Сбросить поиск</button></div>}
  </section>;
}
function FeatherIcon() { return <Sparkles size={16} />; }
