"use client";

import { use, useEffect, useRef, useState } from "react";
import { LAYER_INFO } from "@/lib/memory";

type Turn = {
  id: string;
  turnNumber: number;
  role: string;
  content: string;
  choices: string[];
  dice?: { label: string; success: boolean; d20: number } | null;
  modelUsed?: string | null;
  taskType?: string | null;
};

type Mem = {
  id: string;
  layer: string;
  category: string;
  title: string;
  content: string;
  importance: number;
};

type Item = {
  id: string;
  name: string;
  kind: string;
  description: string;
  quantity: number;
  equipped: boolean;
  icon: string;
};

type Loc = {
  id: string;
  name: string;
  description: string;
  x: number;
  y: number;
  discovered: boolean;
  current: boolean;
  danger: number;
  icon: string;
};

export default function PlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<{
    session: {
      title: string;
      scenarioTitle: string;
      character: {
        name: string;
        archetype: string;
        level: number;
        xp: number;
        hp: number;
        maxHp: number;
        mana: number;
        maxMana: number;
        gold: number;
        stats: Record<string, number>;
        skills: string[];
        traits: string[];
        backstory: string;
      };
      worldState: {
        worldName: string;
        currentLocation: string;
        mainQuest: string;
        danger: number;
        chapter: number;
        tone: string;
        factions: string[];
      };
    };
    turns: Turn[];
    memories: Mem[];
    inventory: Item[];
    locations: Loc[];
  } | null>(null);

  const [action, setAction] = useState("");
  const [busy, setBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [sideTab, setSideTab] = useState<"hero" | "map" | "memory">("hero");
  const [notice, setNotice] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (res.ok) setData(await res.json());
    } finally {
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [data?.turns.length]);

  const lastNarrator = [...(data?.turns ?? [])].reverse().find((t) => t.role === "narrator");
  const choices: string[] = lastNarrator?.choices ?? [];

  async function act(text: string, isCustomAction: boolean) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setAction("");
    setNotice(
      isCustomAction
        ? "⚔️ Мастер обдумывает твоё действие и бросает кости..."
        : "📖 Мастер развивает сцену...",
    );

    try {
      const res = await fetch(`/api/sessions/${id}/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: text.slice(0, 2000), custom: isCustomAction }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const noticeText = j.dice?.label ? `🎲 ${j.dice.label}` : "✨ Ход завершён";
      setNotice(noticeText);
      await load();
      setTimeout(() => setNotice((cur) => (cur === noticeText ? "" : cur)), 6000);
    } catch {
      setNotice("Ошибка связи — попробуй ещё раз");
      setTimeout(() => setNotice((cur) => (cur === "Ошибка связи — попробуй ещё раз" ? "" : cur)), 5000);
    } finally {
      setBusy(false);
    }
  }

  async function compact() {
    setCompacting(true);
    setNotice("📜 Мастер заносит ключевые вехи истории в летопись...");
    try {
      const res = await fetch(`/api/sessions/${id}/compact`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
      const successNotice = "✅ Летопись обновлена: события надёжно зафиксированы";
      setNotice(successNotice);
      await load();
      setTimeout(() => setNotice((cur) => (cur === successNotice ? "" : cur)), 6000);
    } catch {
      setNotice("Не удалось обновить летопись — попробуй позже");
      setTimeout(() => setNotice((cur) => (cur === "Не удалось обновить летопись — попробуй позже" ? "" : cur)), 5000);
    } finally {
      setCompacting(false);
    }
  }

  if (!data) return <p className="pt-16 text-center text-slate-400">Открываем портал хроники…</p>;
  const c = data.session.character;
  const w = data.session.worldState;
  const hpPct = Math.max(0, Math.round((c.hp / c.maxHp) * 100));

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
              ⚔️ Активная кампания
            </span>
          </div>
          <h1 className="mt-1 text-xl font-black text-white">{data.session.title} — {c.name}</h1>
          <p className="text-xs text-slate-400">Квест: {w.mainQuest}</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right text-xs">
            <p className="text-slate-300">❤️ {c.hp}/{c.maxHp} · ⭐ ур.{c.level} · 🪙 {c.gold}</p>
            <div className="mt-1 h-2 w-44 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full ${
                  hpPct > 50
                    ? "bg-gradient-to-r from-emerald-400 to-lime-300"
                    : hpPct > 25
                      ? "bg-gradient-to-r from-amber-400 to-orange-400"
                      : "bg-gradient-to-r from-red-500 to-rose-400"
                }`}
                style={{ width: `${hpPct}%` }}
              />
            </div>
            <p className="mt-1 text-slate-400">Накал: {w.danger}/100 · 📍 {w.currentLocation}</p>
          </div>
          <button
            onClick={compact}
            disabled={compacting}
            className="btn-ghost text-xs"
            title="Зафиксировать главные события и итоги недавних ходов в летопись кампании"
          >
            {compacting ? "Заносим в летопись…" : "📜 Записать в летопись"}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* NARRATIVE LOG */}
        <div className="card flex min-h-[540px] flex-col p-0">
          <div ref={logRef} className="scroll-thin max-h-[560px] flex-1 space-y-3 overflow-y-auto p-5">
            {data.turns.map((t) => {
              return (
                <div key={t.id} className={`fade-up ${t.role === "player" ? "ml-8" : t.role === "dice" ? "mx-auto max-w-md" : "mr-4"}`}>
                  {t.role === "narrator" && (
                    <div className="rounded-2xl border border-amber-200/15 bg-gradient-to-b from-amber-100/[0.07] to-transparent p-4">
                      <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-400">
                        <span className="uppercase tracking-widest text-amber-200/90 font-semibold">
                          📖 Мастер · ход {t.turnNumber}
                        </span>
                      </div>
                      <div className="narrative whitespace-pre-wrap text-[14.5px] leading-relaxed text-slate-100">{t.content}</div>
                    </div>
                  )}

                  {t.role === "player" && (
                    <div className="rounded-2xl border border-violet-300/25 bg-violet-500/15 p-3.5">
                      <div className="flex items-center justify-between text-[11px] text-violet-200">
                        <span className="uppercase tracking-widest">🖐️ Ты · ход {t.turnNumber}</span>
                        {t.taskType === "resolution" && (
                          <span className="rounded bg-violet-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200">
                            Своё действие
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[14px] text-white">«{t.content}»</p>
                    </div>
                  )}

                  {t.role === "dice" && (
                    <div
                      className={`dice-glow rounded-xl border px-4 py-2 text-center font-mono text-[13px] ${
                        t.dice?.success
                          ? "border-emerald-300/40 bg-emerald-400/10 text-emerald-200"
                          : "border-red-300/40 bg-red-400/10 text-red-200"
                      }`}
                    >
                      {t.content}
                    </div>
                  )}
                </div>
              );
            })}
            {busy && <p className="animate-pulse text-center text-sm text-amber-200">✨ Мастер разворачивает сцену… кости брошены…</p>}
          </div>

          {/* ACTIONS */}
          <div className="space-y-2.5 border-t border-white/10 p-4">
            {notice && <p className="text-xs text-amber-200 font-medium">{notice}</p>}

            {/* Standard preset choices */}
            <div className="grid gap-2">
              <div className="flex items-center justify-between text-[12px] font-medium text-slate-300">
                <span>Варианты развития событий:</span>
              </div>
              {choices.map((ch, i) => (
                <button
                  key={i}
                  disabled={busy}
                  onClick={() => act(ch, false)}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-left text-[13.5px] text-slate-100 transition hover:border-amber-300/50 hover:bg-amber-300/10 disabled:opacity-50"
                >
                  <b className="mr-2 text-amber-300">{i + 1}</b> {ch}
                </button>
              ))}
            </div>

            {/* Free-form custom action */}
            <div className="pt-1">
              <div className="mb-1.5 flex items-center justify-between text-[12px] font-medium text-slate-300">
                <span>Или опиши своё действие:</span>
                <span className="text-[11px] text-violet-300">🎲 Проверка d20 по характеристикам</span>
              </div>
              <div className="flex gap-2">
                <input
                  className="input text-sm"
                  placeholder="Например: «подкупаю стражника редким зельем», «взбираюсь на люстру и прыгаю»…"
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") act(action, true);
                  }}
                  disabled={busy}
                />
                <button
                  onClick={() => act(action, true)}
                  disabled={busy || !action.trim()}
                  className="btn-primary shrink-0 text-xs font-bold"
                >
                  {busy ? "…" : "⚔️ Действовать"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* SIDE PANELS */}
        <div className="space-y-4">
          <div className="card p-2">
            <div className="flex gap-1 p-1 text-[13px]">
              {(["hero", "map", "memory"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setSideTab(t)}
                  className={`flex-1 rounded-lg px-3 py-2 ${
                    sideTab === t ? "bg-white/15 font-bold text-white" : "text-slate-400"
                  }`}
                >
                  {t === "hero" ? "🦸 Герой & рюкзак" : t === "map" ? "🗺️ Карта" : "📜 Летопись"}
                </button>
              ))}
            </div>

            <div className="p-3">
              {/* HERO TAB */}
              {sideTab === "hero" && (
                <div className="space-y-3 text-[13px]">
                  <div className="rounded-xl bg-black/30 p-3">
                    <b className="text-white">{c.name}</b> <span className="text-amber-200">· {c.archetype}</span>
                    <p className="mt-1 text-slate-300">{c.backstory}</p>
                    <div className="mt-2 grid grid-cols-3 gap-1.5 font-mono text-[12px]">
                      {Object.entries(c.stats).map(([k, v]) => (
                        <span key={k} className="rounded-lg bg-white/5 px-2 py-1 text-center text-slate-200">
                          {k} <b className="text-amber-200">{v}</b>
                        </span>
                      ))}
                    </div>
                    <p className="mt-2 text-slate-400">Навыки: {c.skills.join(" · ")}</p>
                    <p className="text-slate-400">Черты: {c.traits.join(" · ")}</p>
                    <p className="mt-1 text-slate-400">XP {c.xp} · мана {c.mana}/{c.maxMana}</p>
                  </div>

                  <p className="text-xs uppercase tracking-widest text-slate-400">🎒 Инвентарь ({data.inventory.length})</p>
                  <div className="grid gap-1.5">
                    {data.inventory.map((it) => (
                      <div key={it.id} className="flex items-start gap-2 rounded-xl bg-white/5 px-3 py-2">
                        <span className="text-lg">{it.icon}</span>
                        <span>
                          <b className="text-slate-100">{it.name}</b>{" "}
                          {it.equipped && <span className="text-[10px] text-emerald-300">● надето</span>}{" "}
                          <span className="text-[11px] text-slate-500">×{it.quantity} · {it.kind}</span>
                          <span className="block text-[12px] text-slate-400">{it.description}</span>
                        </span>
                      </div>
                    ))}
                    {!data.inventory.length && <p className="text-xs text-slate-500">Пусто.</p>}
                  </div>
                </div>
              )}

              {/* MAP TAB */}
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
                        <circle
                          cx={l.x * 10}
                          cy={l.y * 10}
                          r={l.current ? 6 : 4.5}
                          fill={l.current ? "#f59e0b" : l.danger > 50 ? "#ef4444" : "#8b5cf6"}
                          opacity={0.85}
                        />
                        <text x={l.x * 10} y={l.y * 10 - 8} textAnchor="middle" fontSize="6" fill="#fff">
                          {l.icon} {l.discovered ? l.name.slice(0, 14) : "???"}
                        </text>
                        {l.current && (
                          <circle cx={l.x * 10} cy={l.y * 10} r={9} fill="none" stroke="#fbbf24" strokeWidth="1" strokeDasharray="3 2" />
                        )}
                      </g>
                    ))}
                  </svg>
                  <div className="mt-2 space-y-1.5 text-[12.5px]">
                    {data.locations.map((l) => (
                      <div
                        key={l.id}
                        className={`rounded-lg px-3 py-1.5 ${
                          l.current ? "bg-amber-300/15 text-amber-100" : "bg-white/5 text-slate-300"
                        }`}
                      >
                        {l.icon} <b>{l.discovered ? l.name : "Неизведанное"}</b> {l.current && "· ТЫ ЗДЕСЬ"}{" "}
                        <span className="text-slate-500">· ☠ {l.danger}</span>
                        {l.discovered && <span className="block text-slate-400">{l.description}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* MEMORY TAB */}
              {sideTab === "memory" && (
                <div className="space-y-2">
                  <p className="text-[12px] leading-relaxed text-slate-400">
                    Летопись приключения: ключевые решения, важные персонажи, история мира и последствия твоих выборов.
                  </p>
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
                          {nodes.slice(0, 8).map((m) => (
                            <div key={m.id} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-[12px]">
                              <span className="font-semibold text-amber-100">{m.title}</span>
                              <span className="block mt-0.5 text-slate-300">{m.content.slice(0, 160)}</span>
                            </div>
                          ))}
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
