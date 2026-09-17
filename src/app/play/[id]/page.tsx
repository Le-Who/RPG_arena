"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { LAYER_INFO, SOURCE_INFO } from "@/lib/memory-ui";
import type { AppliedChanges, DiceResult } from "@/db/schema";
import type { ProfileSpec } from "@/lib/profiles";

type Turn = {
  id: string;
  turnNumber: number;
  role: string;
  content: string;
  choices: string[];
  dice?: DiceResult | null;
  modelUsed?: string | null;
  taskType?: string | null;
  stateChanges?: AppliedChanges | null;
  contextMeta?: { retrievedIds?: string[]; model?: string } | null;
};
type Mem = { id: string; layer: string; category: string; title: string; content: string; importance: number; source: string; sourceTurn: number | null; evidence: string | null };
type Item = { id: string; name: string; kind: string; description: string; quantity: number; equipped: boolean; icon: string };
type Loc = { id: string; name: string; description: string; x: number; y: number; discovered: boolean; current: boolean; danger: number; icon: string };
type Quest = { id: string; key: string; title: string; description: string; status: string; progress: number; isMain: boolean };
type Npc = { id: string; key: string; name: string; role: string; description: string; relation: number; status: string; lastLocation: string };
type SceneObj = { id: string; key: string; name: string; state: string; description: string; locationName: string };
type Data = {
  session: {
    title: string;
    scenarioTitle: string;
    campaignMode: "preset" | "free";
    rulesProfile: string;
    character: { name: string; archetype: string; level: number; xp: number; hp: number; maxHp: number; gold: number; stats: Record<string, number>; skills: string[]; traits: string[]; backstory: string; conditions?: string[] };
    worldState: { worldName: string; currentLocation: string; mainQuest: string; danger: number; chapter: number; tone: string; factions: string[] };
    turnCount: number;
    contextTokensEstimate: number;
  };
  profile: ProfileSpec;
  turns: Turn[];
  memories: Mem[];
  inventory: Item[];
  locations: Loc[];
  quests: Quest[];
  npcs: Npc[];
  sceneObjects: SceneObj[];
  embeddings: { nodes: number; ready: number; pending: number; failed: number } | null;
};
type SearchHit = { id: string; layer: string; title: string; content: string; similarity: number; why: string; source: string; sourceTurn: number | null };

function ChangesSummary({ a, profile }: { a: AppliedChanges; profile: ProfileSpec }) {
  const chips: { text: string; tone: "good" | "bad" | "info" }[] = [];
  if (profile.resources.hp && a.hp) chips.push({ text: `${profile.labels.hp} ${a.hp > 0 ? "+" : ""}${a.hp}`, tone: a.hp > 0 ? "good" : "bad" });
  if (profile.resources.xp && a.xp) chips.push({ text: `${profile.labels.xp} +${a.xp}`, tone: "good" });
  if (profile.resources.gold && a.gold) chips.push({ text: `${profile.labels.gold} ${a.gold > 0 ? "+" : ""}${a.gold}`, tone: a.gold > 0 ? "good" : "bad" });
  if (a.levelUp) chips.push({ text: "⬆ Новый уровень", tone: "good" });
  if (a.location) chips.push({ text: `📍 ${a.location.from} → ${a.location.to}${a.location.isNew ? " (новое место)" : ""}`, tone: "info" });
  for (const q of a.quests) chips.push({ text: `🎯 ${q.title}: ${q.status === "completed" ? "выполнен" : q.status === "failed" ? "провален" : q.isNew ? "новая цель" : `${q.progress}%`}`, tone: q.status === "failed" ? "bad" : q.status === "completed" ? "good" : "info" });
  for (const n of a.npcs) chips.push({ text: `👤 ${n.name}${n.isNew ? " (новый)" : ""} ${n.delta ? `${n.delta > 0 ? "+" : ""}${n.delta} → ${n.relation}` : `${n.relation}`}${n.status !== "alive" ? ` · ${n.status}` : ""}`, tone: n.delta < 0 || n.status === "dead" ? "bad" : n.delta > 0 ? "good" : "info" });
  for (const i of a.inventory) chips.push({ text: `${i.op === "add" ? "🎒 +" : i.op === "consume" ? "🧪 использовано:" : i.op === "remove" ? "🗑 утрачено:" : i.op === "equip" ? "🛡 надето:" : "снято:"} ${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}${!i.ok ? ` ✗ ${i.reason ?? ""}` : ""}`, tone: !i.ok ? "bad" : i.op === "add" ? "good" : "info" });
  for (const o of a.sceneObjects) chips.push({ text: `🧩 ${o.name}: ${o.state}`, tone: "info" });
  for (const c of a.conditions.added) chips.push({ text: `⚠ ${c}`, tone: "bad" });
  for (const c of a.conditions.removed) chips.push({ text: `✓ снято: ${c}`, tone: "good" });
  if (a.danger) chips.push({ text: `накал ${a.danger > 0 ? "+" : ""}${a.danger}`, tone: a.danger > 0 ? "bad" : "good" });
  if (!chips.length && !a.rejected.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((c, i) => (
        <span key={i} className={`rounded-full border px-2 py-0.5 text-[10.5px] ${c.tone === "good" ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-200" : c.tone === "bad" ? "border-red-300/30 bg-red-400/10 text-red-200" : "border-sky-300/30 bg-sky-400/10 text-sky-200"}`}>
          {c.text}
        </span>
      ))}
      {a.rejected.length > 0 && (
        <span title={a.rejected.join("\n")} className="rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 text-[10.5px] text-amber-200">
          🛡 сервер отклонил: {a.rejected.length}
        </span>
      )}
    </div>
  );
}

export default function PlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<Data | null>(null);
  const [action, setAction] = useState("");
  const [busy, setBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [sideTab, setSideTab] = useState<"hero" | "quests" | "map" | "memory">("hero");
  const [notice, setNotice] = useState("");
  const [aiError, setAiError] = useState<{ code: string; message: string; details?: string; retry?: { text: string; custom: boolean } } | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const busyRef = useRef(false);
  const compactingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current || busyRef.current || compactingRef.current) return;
    loadingRef.current = true;
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (res.ok) setData(await res.json());
    } finally {
      loadingRef.current = false;
    }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [data?.turns.length]);

  const lastNarrator = [...(data?.turns ?? [])].reverse().find((t) => t.role === "narrator");
  const choices: string[] = lastNarrator?.choices ?? [];

  async function act(text: string, isCustomAction: boolean, requestId?: string) {
    if (!text.trim() || busyRef.current || compactingRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setAiError(null);
    setAction("");
    setNotice(isCustomAction ? "⚔️ Мастер обдумывает твоё действие…" : "📖 Мастер развивает сцену…");
    const rid = requestId ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    try {
      const res = await fetch(`/api/sessions/${id}/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: text.slice(0, 2000), custom: isCustomAction, requestId: rid }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setAiError({ code: j.code ?? `HTTP ${res.status}`, message: j.message ?? "Ошибка", details: j.details, retry: { text, custom: isCustomAction } });
        setAction(isCustomAction ? text : "");
        setNotice("");
        return;
      }
      const noticeText = j.dice?.label ? `🎲 ${j.dice.label}` : j.replay ? "↺ Ход уже был применён" : "✨ Ход завершён";
      setNotice(noticeText);
      busyRef.current = false;
      await load();
      setTimeout(() => setNotice((cur) => (cur === noticeText ? "" : cur)), 6000);
      if (j.needsCompaction && !compactingRef.current) {
        compactingRef.current = true;
        setCompacting(true);
        setTimeout(async () => {
          try {
            setNotice("📜 Мастер заносит вехи истории в летопись…");
            await fetch(`/api/sessions/${id}/compact`, { method: "POST" });
            compactingRef.current = false;
            await load();
          } catch {
            /* best-effort */
          } finally {
            compactingRef.current = false;
            setCompacting(false);
            setNotice("");
          }
        }, 800);
      }
    } catch {
      setNotice("Ошибка связи — попробуй ещё раз");
      setTimeout(() => setNotice((cur) => (cur === "Ошибка связи — попробуй ещё раз" ? "" : cur)), 5000);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function compact() {
    if (compactingRef.current) return;
    compactingRef.current = true;
    setCompacting(true);
    setNotice("📜 Мастер заносит ключевые вехи истории в летопись…");
    try {
      const res = await fetch(`/api/sessions/${id}/compact`, { method: "POST" });
      const j = await res.json();
      const ok = `✅ Летопись обновлена: ${j.created ?? 0} записей (${j.mode ?? ""})`;
      setNotice(ok);
      compactingRef.current = false;
      await load();
      setTimeout(() => setNotice((cur) => (cur === ok ? "" : cur)), 6000);
    } catch {
      setNotice("Не удалось обновить летопись — попробуй позже");
    } finally {
      compactingRef.current = false;
      setCompacting(false);
    }
  }

  async function search() {
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/sessions/${id}/memory/search?q=${encodeURIComponent(searchQ)}&k=8`);
      const j = await res.json();
      setSearchHits(res.ok ? j.results : []);
      if (!res.ok) setNotice(j.message ?? "Поиск недоступен");
    } finally {
      setSearching(false);
    }
  }

  async function reindex() {
    setReindexing(true);
    try {
      const res = await fetch(`/api/sessions/${id}/memory/reindex`, { method: "POST" });
      const j = await res.json();
      setNotice(res.ok ? `🧭 Индексация: +${j.indexed}, в очереди ${j.pending}, ошибок ${j.failed}` : j.message ?? "Не удалось");
      await load();
    } finally {
      setReindexing(false);
    }
  }

  if (!data) return <p className="pt-16 text-center text-slate-400">Открываем хронику…</p>;
  const c = data.session.character;
  const w = data.session.worldState;
  const p = data.profile;
  const hpPct = c.maxHp ? Math.max(0, Math.round((c.hp / c.maxHp) * 100)) : 0;
  const activeQuests = data.quests.filter((q) => q.status === "active");
  const hereObjects = data.sceneObjects.filter((o) => o.locationName.toLowerCase() === w.currentLocation.toLowerCase());

  return (
    <div className="space-y-4 pt-6">
      {/* HEADER */}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.2em] text-violet-300">
              {w.worldName} · глава {w.chapter} · {data.session.scenarioTitle}
            </span>
            <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-violet-200">
              {data.session.campaignMode === "preset" ? "📚 пресет" : "✍️ свободная"} · {p.short}
            </span>
          </div>
          <h1 className="mt-1 text-xl font-black text-white">
            {data.session.title} — {c.name}
          </h1>
          <p className="text-xs text-slate-400">Цель: {w.mainQuest}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-xs">
            <p className="text-slate-300">
              {p.uiPanels.hpBar && <>❤️ {c.hp}/{c.maxHp} · </>}
              {p.uiPanels.xpLevel && <>⭐ ур.{c.level} · </>}
              {p.uiPanels.gold && <>🪙 {c.gold} · </>}
              📍 {w.currentLocation}
            </p>
            {p.uiPanels.hpBar && (
              <div className="mt-1 ml-auto h-2 w-44 overflow-hidden rounded-full bg-white/10">
                <div className={`h-full rounded-full ${hpPct > 50 ? "bg-gradient-to-r from-emerald-400 to-lime-300" : hpPct > 25 ? "bg-gradient-to-r from-amber-400 to-orange-400" : "bg-gradient-to-r from-red-500 to-rose-400"}`} style={{ width: `${hpPct}%` }} />
              </div>
            )}
            <p className="mt-1 text-slate-400">
              Накал: {w.danger}/100{c.conditions?.length ? ` · ⚠ ${c.conditions.join(", ")}` : ""}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            {(data.session.contextTokensEstimate ?? 0) > 0 && (
              <span title="Оценка токенов последнего промпта" className={`text-[10px] font-mono tabular-nums ${data.session.contextTokensEstimate >= 18000 ? "text-red-400" : data.session.contextTokensEstimate >= 8000 ? "text-amber-400" : "text-emerald-400"}`}>
                🧠 {(data.session.contextTokensEstimate / 1000).toFixed(1)}k токенов
              </span>
            )}
            <button onClick={compact} disabled={compacting} className="btn-ghost text-xs" title="Сжать недавние ходы в летопись">
              {compacting ? "Заносим…" : "📜 Записать в летопись"}
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* LOG */}
        <div className="card flex min-h-[540px] flex-col p-0">
          <div ref={logRef} className="scroll-thin max-h-[580px] flex-1 space-y-3 overflow-y-auto p-5">
            {data.turns.map((t) => (
              <div key={t.id} className={`fade-up ${t.role === "player" ? "ml-8" : t.role === "dice" ? "mx-auto max-w-md" : "mr-4"}`}>
                {t.role === "narrator" && (
                  <div className="rounded-2xl border border-amber-200/15 bg-gradient-to-b from-amber-100/[0.07] to-transparent p-4">
                    <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-widest text-amber-300/80">
                      <span>🎭 Мастер · ход {t.turnNumber}</span>
                      <span className="text-slate-500 normal-case tracking-normal">
                        {t.modelUsed}
                        {t.contextMeta?.retrievedIds?.length ? ` · 🔎 ${t.contextMeta.retrievedIds.length} восп.` : ""}
                      </span>
                    </div>
                    {t.dice && p.uiPanels.dice && (
                      <div className={`mb-2 inline-block rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold ${t.dice.success ? "border-emerald-300/40 bg-emerald-400/10 text-emerald-200" : "border-red-300/40 bg-red-400/10 text-red-200"}`}>🎲 {t.dice.label}</div>
                    )}
                    <div className="narrative whitespace-pre-wrap text-[14px] leading-relaxed text-slate-100">{t.content}</div>
                    {t.stateChanges && <ChangesSummary a={t.stateChanges} profile={p} />}
                  </div>
                )}
                {t.role === "player" && (
                  <div className="rounded-2xl border border-violet-300/20 bg-violet-500/10 px-4 py-2.5 text-[13.5px] text-violet-50">
                    <span className="mr-2 text-[10px] uppercase tracking-widest text-violet-300">Ты</span>
                    {t.content}
                  </div>
                )}
                {t.role === "dice" && (
                  <div className={`rounded-xl border px-3 py-1.5 text-center text-[12px] font-semibold ${t.dice?.success ? "border-emerald-300/40 bg-emerald-400/10 text-emerald-200" : "border-red-300/40 bg-red-400/10 text-red-200"}`}>{t.content}</div>
                )}
              </div>
            ))}
            {busy && <p className="animate-pulse text-center text-sm text-amber-200">✨ Мастер разворачивает сцену…</p>}
          </div>

          {/* ACTIONS */}
          <div className="space-y-2.5 border-t border-white/10 p-4">
            {notice && <p className="text-xs font-medium text-amber-200">{notice}</p>}
            {aiError && (
              <div className="rounded-xl border border-red-300/30 bg-red-500/10 p-3 text-[13px] text-red-100">
                <b>{aiError.code === "AI_REQUIRED" ? "Нужен ИИ-мастер" : aiError.code === "AI_FAILED" ? "ИИ временно недоступен" : "Ошибка"}:</b> {aiError.message}
                {aiError.details && <span className="block text-[11px] text-red-200/70">{aiError.details}</span>}
                <div className="mt-2 flex gap-2">
                  {aiError.code === "AI_REQUIRED" ? (
                    <a href="/settings" className="btn-ghost text-xs">⚙️ Открыть настройки</a>
                  ) : (
                    aiError.retry && (
                      <button onClick={() => act(aiError.retry!.text, aiError.retry!.custom)} className="btn-ghost text-xs">↻ Повторить ход</button>
                    )
                  )}
                  <button onClick={() => setAiError(null)} className="text-xs text-slate-400 underline">скрыть</button>
                </div>
              </div>
            )}
            <div className="grid gap-2">
              <div className="text-[12px] font-medium text-slate-300">Варианты развития событий:</div>
              {choices.map((ch, i) => (
                <button key={i} disabled={busy || compacting} onClick={() => act(ch, false)} className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-left text-[13.5px] text-slate-100 transition hover:border-amber-300/50 hover:bg-amber-300/10 disabled:opacity-50">
                  <b className="mr-2 text-amber-300">{i + 1}</b> {ch}
                </button>
              ))}
            </div>
            <div className="pt-1">
              <div className="mb-1.5 flex items-center justify-between text-[12px] font-medium text-slate-300">
                <span>Или опиши своё действие:</span>
                <span className="text-[11px] text-violet-300">{p.check === "d20" ? "🎲 серверная проверка d20" : p.check === "2d6" ? "🎲 риск-проверка 2d6" : "📖 исход по канону истории"}</span>
              </div>
              <div className="flex gap-2">
                <input
                  className="input text-sm"
                  placeholder={p.check === "none" ? "Например: «признаюсь Марте, что видел письмо», «ухожу через чёрный ход»…" : "Например: «подкупаю охранника», «взбираюсь по водостоку»…"}
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") act(action, true);
                  }}
                  disabled={busy || compacting}
                />
                <button onClick={() => act(action, true)} disabled={busy || compacting || !action.trim()} className="btn-primary shrink-0 text-xs font-bold">
                  {busy || compacting ? "…" : "⚔️ Действовать"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* SIDE */}
        <div className="space-y-4">
          <div className="card p-2">
            <div className="flex gap-1 p-1 text-[12.5px]">
              {(["hero", "quests", "map", "memory"] as const).map((t) => (
                <button key={t} onClick={() => setSideTab(t)} className={`flex-1 rounded-lg px-2 py-2 ${sideTab === t ? "bg-white/15 font-bold text-white" : "text-slate-400"}`}>
                  {t === "hero" ? "🦸 Герой" : t === "quests" ? `🎯 Цели${activeQuests.length ? ` ${activeQuests.length}` : ""}` : t === "map" ? "🗺️ Мир" : "📜 Память"}
                </button>
              ))}
            </div>
            <div className="p-3">
              {sideTab === "hero" && (
                <div className="space-y-3 text-[13px]">
                  <div className="rounded-xl bg-black/30 p-3">
                    <b className="text-white">{c.name}</b> <span className="text-amber-200">· {c.archetype}</span>
                    <p className="mt-1 text-slate-300">{c.backstory}</p>
                    {p.uiPanels.stats && (
                      <div className="mt-2 grid grid-cols-3 gap-1.5 font-mono text-[12px]">
                        {Object.entries(c.stats ?? {}).map(([k, v]) => (
                          <span key={k} className="rounded-lg bg-white/5 px-2 py-1 text-center text-slate-200">
                            {k} <b className="text-amber-200">{v}</b>
                          </span>
                        ))}
                      </div>
                    )}
                    {c.skills?.length > 0 && <p className="mt-2 text-slate-400">Навыки: {c.skills.join(" · ")}</p>}
                    {c.traits?.length > 0 && <p className="text-slate-400">Черты: {c.traits.join(" · ")}</p>}
                    {p.uiPanels.xpLevel && <p className="mt-1 text-slate-400">{p.labels.xp}: {c.xp} (до уровня {120 - (c.xp % 120)})</p>}
                    {p.uiPanels.conditions && (
                      <p className="mt-1 text-slate-400">
                        Состояния: {c.conditions?.length ? c.conditions.map((x) => <span key={x} className="mr-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-100">{x}</span>) : <span className="text-slate-500">нет</span>}
                      </p>
                    )}
                    <p className="mt-1 text-[11px] text-slate-500">{p.label}: {p.description}</p>
                  </div>
                  <p className="text-xs uppercase tracking-widest text-slate-400">🎒 Инвентарь ({data.inventory.length})</p>
                  <div className="grid gap-1.5">
                    {data.inventory.map((it) => (
                      <div key={it.id} className="flex items-start gap-2 rounded-xl bg-white/5 px-3 py-2">
                        <span className="text-lg">{it.icon}</span>
                        <span className="flex-1">
                          <b className="text-slate-100">{it.name}</b> {it.equipped && <span className="text-[10px] text-emerald-300">● надето</span>}{" "}
                          <span className="text-[11px] text-slate-500">×{it.quantity} · {it.kind}</span>
                          <span className="block text-[12px] text-slate-400">{it.description}</span>
                        </span>
                        <button disabled={busy || compacting} onClick={() => act(`Использую ${it.name}`, true)} className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/10" title="Свободное действие с этим предметом">
                          использовать
                        </button>
                      </div>
                    ))}
                    {!data.inventory.length && <p className="text-xs text-slate-500">Пусто — предметы появляются по ходу истории.</p>}
                  </div>
                </div>
              )}

              {sideTab === "quests" && (
                <div className="space-y-3 text-[13px]">
                  <p className="text-xs uppercase tracking-widest text-slate-400">🎯 Цели</p>
                  {data.quests.map((q) => (
                    <div key={q.id} className={`rounded-xl px-3 py-2 ${q.status === "active" ? "bg-white/5" : "bg-black/20 opacity-70"}`}>
                      <div className="flex items-center justify-between">
                        <b className="text-slate-100">{q.isMain ? "★ " : ""}{q.title}</b>
                        <span className={`text-[10px] uppercase ${q.status === "completed" ? "text-emerald-300" : q.status === "failed" ? "text-red-300" : "text-amber-200"}`}>{q.status === "completed" ? "выполнен" : q.status === "failed" ? "провален" : q.status === "hidden" ? "скрыт" : "активен"}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-gradient-to-r from-amber-300 to-violet-400" style={{ width: `${q.progress}%` }} />
                      </div>
                      {q.description && <p className="mt-1 text-[11.5px] text-slate-400">{q.description.slice(-220)}</p>}
                    </div>
                  ))}
                  <p className="pt-1 text-xs uppercase tracking-widest text-slate-400">👥 Персонажи ({data.npcs.length})</p>
                  {data.npcs.map((n) => (
                    <div key={n.id} className="rounded-xl bg-white/5 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <b className="text-slate-100">{n.name}</b>
                        <span className={`text-[11px] font-mono ${n.relation > 20 ? "text-emerald-300" : n.relation < -20 ? "text-red-300" : "text-slate-400"}`}>{n.relation > 0 ? "+" : ""}{n.relation}{n.status !== "alive" ? ` · ${n.status}` : ""}</span>
                      </div>
                      <p className="text-[11.5px] text-slate-400">{n.role}{n.lastLocation ? ` · ${n.lastLocation}` : ""}</p>
                      {n.description && <p className="text-[11.5px] text-slate-500">{n.description.slice(-180)}</p>}
                    </div>
                  ))}
                  {!data.npcs.length && <p className="text-xs text-slate-500">Пока никого не встречено.</p>}
                </div>
              )}

              {sideTab === "map" && (
                <div>
                  <svg viewBox="0 0 120 100" className="w-full rounded-xl border border-white/10 bg-[#0d1428]">
                    <defs>
                      <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
                        <path d="M10 0H0v10" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="0.5" />
                      </pattern>
                    </defs>
                    <rect width="120" height="100" fill="url(#grid)" />
                    {data.locations.map((l) => (
                      <g key={l.id} opacity={l.discovered ? 1 : 0.28}>
                        <circle cx={l.x * 10} cy={l.y * 10} r={l.current ? 6 : 4.5} fill={l.current ? "#f59e0b" : l.danger > 50 ? "#ef4444" : "#8b5cf6"} opacity={0.85} />
                        <text x={l.x * 10} y={l.y * 10 - 8} textAnchor="middle" fontSize="6" fill="#fff">
                          {l.icon} {l.discovered ? l.name.slice(0, 14) : "???"}
                        </text>
                        {l.current && <circle cx={l.x * 10} cy={l.y * 10} r={9} fill="none" stroke="#fbbf24" strokeWidth="1" strokeDasharray="3 2" />}
                      </g>
                    ))}
                  </svg>
                  <div className="mt-2 space-y-1.5 text-[12.5px]">
                    {data.locations.map((l) => (
                      <div key={l.id} className={`rounded-lg px-3 py-1.5 ${l.current ? "bg-amber-300/15 text-amber-100" : "bg-white/5 text-slate-300"}`}>
                        {l.icon} <b>{l.discovered ? l.name : "Неизведанное"}</b> {l.current && "· ТЫ ЗДЕСЬ"} <span className="text-slate-500">· ☠ {l.danger}</span>
                        {l.discovered && <span className="block text-slate-400">{l.description}</span>}
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-xs uppercase tracking-widest text-slate-400">🧩 Объекты сцены · {w.currentLocation}</p>
                  <div className="mt-1 space-y-1 text-[12.5px]">
                    {hereObjects.map((o) => (
                      <div key={o.id} className="rounded-lg bg-white/5 px-3 py-1.5 text-slate-300">
                        <b className="text-slate-100">{o.name}</b> <span className="text-sky-200">[{o.state}]</span>
                        {o.description && <span className="block text-[11.5px] text-slate-400">{o.description.slice(0, 160)}</span>}
                      </div>
                    ))}
                    {!hereObjects.length && <p className="text-xs text-slate-500">Пока не зафиксированы — появятся, когда история их затронет.</p>}
                  </div>
                </div>
              )}

              {sideTab === "memory" && (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input className="input text-sm" placeholder="Семантический поиск: «кто такая Марта», «что я обещал»…" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
                    <button onClick={search} disabled={searching || !searchQ.trim()} className="btn-ghost shrink-0 text-xs">{searching ? "…" : "🔎"}</button>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>
                      {data.embeddings ? `эмбеддинги: ${data.embeddings.ready}/${data.embeddings.nodes} готово${data.embeddings.pending ? `, ${data.embeddings.pending} в очереди` : ""}${data.embeddings.failed ? `, ${data.embeddings.failed} ошибок` : ""}` : "эмбеддинги: нет данных"}
                    </span>
                    <button onClick={reindex} disabled={reindexing} className="underline hover:text-slate-300">{reindexing ? "индексируем…" : "переиндексировать"}</button>
                  </div>
                  {searchHits && (
                    <div className="rounded-xl border border-violet-300/20 bg-violet-500/5 p-2">
                      <div className="mb-1 flex items-center justify-between text-[11px] text-violet-200">
                        <span>Найдено: {searchHits.length}</span>
                        <button onClick={() => setSearchHits(null)} className="underline">закрыть</button>
                      </div>
                      {searchHits.map((h) => (
                        <div key={h.id} className="mb-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-[12px]">
                          <span className="font-semibold text-amber-100">{h.title}</span> <span className="text-[10px] text-slate-500">{h.why}</span>
                          <span className="mt-0.5 block text-slate-300">{h.content.slice(0, 220)}</span>
                        </div>
                      ))}
                      {!searchHits.length && <p className="text-[12px] text-slate-500">Ничего похожего. Возможно, память ещё не проиндексирована.</p>}
                    </div>
                  )}
                  {Object.keys(LAYER_INFO).map((layer) => {
                    const nodes = data.memories.filter((m) => m.layer === layer);
                    if (!nodes.length) return null;
                    const info = LAYER_INFO[layer as keyof typeof LAYER_INFO];
                    return (
                      <details key={layer} open={layer === "chronicle" || layer === "episodic"} className="rounded-xl border border-white/10 bg-black/30">
                        <summary className="cursor-pointer px-3 py-2 text-[13px] font-bold text-white">
                          {info.icon} {info.label} · {nodes.length} <span className="font-normal text-slate-500">— {info.hint}</span>
                        </summary>
                        <div className="space-y-1.5 p-2.5">
                          {nodes.slice(0, 10).map((m) => {
                            const src = SOURCE_INFO[m.source as keyof typeof SOURCE_INFO] ?? SOURCE_INFO.heuristic;
                            return (
                              <div key={m.id} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-[12px]">
                                <div className="flex items-start justify-between gap-2">
                                  <span className="font-semibold text-amber-100">{m.title}</span>
                                  <span title={src.hint} className="shrink-0 text-[10px] text-slate-500">{src.icon} {src.label}{m.sourceTurn ? ` · ход ${m.sourceTurn}` : ""}</span>
                                </div>
                                <span className="mt-0.5 block text-slate-300">{m.content.slice(0, 180)}</span>
                                {m.evidence && <span className="mt-0.5 block text-[11px] italic text-slate-500">«{m.evidence.slice(0, 120)}»</span>}
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
