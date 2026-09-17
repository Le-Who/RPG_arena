"use client";

import { useEffect, useState } from "react";
import { SCENARIOS } from "@/lib/scenarios";

type Session = { id: string; title: string; scenarioTitle: string; turnCount: number; status: string; updatedAt: string };

export default function HomePage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [ai, setAi] = useState<{ keysCount: number; useLiveAI: boolean; primaryModel: string } | null>(null);
  const [tab, setTab] = useState<"preset" | "custom">("preset");
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const [charIdx, setCharIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [custom, setCustom] = useState({ title: "", worldName: "", pitch: "", mainQuest: "", tone: "", name: "", archetype: "", backstory: "" });

  const sc = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];

  async function refresh() {
    const [a, c] = await Promise.all([
      fetch("/api/sessions").then((r) => r.json()).catch(() => ({ sessions: [] })),
      fetch("/api/settings").then((r) => r.json()).catch(() => null),
    ]);
    setSessions(a.sessions ?? []);
    setAi(c);
  }
  useEffect(() => { refresh(); }, []);

  async function create() {
    setLoading(true);
    try {
      const body =
        tab === "preset"
          ? { mode: "preset", scenarioId, characterIndex: charIdx }
          : {
              mode: "custom",
              customScenario: { title: custom.title || "Своя история", worldName: custom.worldName || "Авторский мир", pitch: custom.pitch, mainQuest: custom.mainQuest, tone: custom.tone || "приключенческий" },
              customCharacter: { name: custom.name || "Странник", archetype: custom.archetype || "Авантюрист", backstory: custom.backstory },
            };
      const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.session) window.location.href = `/play/${data.session.id}`;
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6 pt-8">
      {/* HERO */}
      <div className="card fade-up overflow-hidden">
        <div className="grid gap-6 p-6 md:grid-cols-[1.2fr_0.8fr] md:p-10">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-amber-300/90">Интерактивное D&amp;D-приключение · Живой мир · Броски d20</p>
            <h1 className="mt-2 text-3xl font-black leading-[1.05] text-white md:text-5xl">
              История пишется костями <span className="bg-gradient-to-r from-amber-300 to-violet-400 bg-clip-text text-transparent">и твоими решениями</span>
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-slate-300">
              Выбери готовое сказание или создай свой уникальный мир. Каждое твоё решение направляет сюжет:
              выбирай предложенные варианты или <b className="text-white">совершай любые свои поступки</b>.
              Исход определят характеристики героя, честные броски кубика d20 и история твоих прошлых выборов.
            </p>
            <div className="mt-5 flex flex-wrap gap-2 text-sm">
              <a href="#new" className="btn-primary">🎲 Начать приключение</a>
              <a href="/settings" className="btn-ghost">⚙️ Настройки</a>
            </div>
            <div className="mt-5 flex flex-wrap gap-2 text-[12px]">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">🎲 Проверки d20 по статам</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">📜 Хранение канона и памяти</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">🗺️ Интерактивная карта</span>
              <span className={`rounded-full border px-3 py-1 ${ai?.useLiveAI && (ai?.keysCount ?? 0) > 0 ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-200" : "border-amber-300/30 bg-amber-300/10 text-amber-200"}`}>
                {ai?.useLiveAI && (ai?.keysCount ?? 0) > 0 ? "● ИИ-Мастер на связи" : "● Автономный режим"}
              </span>
            </div>
          </div>
          <div className="grid content-start gap-3">
            <div className="rounded-2xl border border-white/10 bg-black/40 p-4">
              <p className="text-xs uppercase tracking-widest text-slate-400">Как устроена игра</p>
              <ol className="mt-2 space-y-2 text-[13px] text-slate-300">
                <li>🎭 <b className="text-white">Мастер</b> описывает сцену и обстановку вокруг</li>
                <li>🖐️ <b className="text-white">Ты</b> выбираешь действие или предлагаешь своё</li>
                <li>🎲 <b className="text-white">Кости d20</b> и статы честно решают исход</li>
                <li>📜 <b className="text-white">Летопись</b> сохраняет принятые решения и последствия</li>
                <li>🗺️ <b className="text-white">Мир</b> меняется: локации, лут, раны и фракции</li>
              </ol>
            </div>
            <div className="rounded-2xl border border-violet-300/20 bg-violet-500/10 p-4 text-[13px] text-violet-100">
              💡 Полная свобода: «подкупить стражника песней», «поджечь мост и бежать» — Мастер и кубик d20 определят исход с учётом ситуации, характеристик и истории героя.
            </div>
          </div>
        </div>
      </div>

      {/* NEW GAME */}
      <div id="new" className="card fade-up p-6 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-extrabold text-white">✨ Новая кампания</h2>
          <div className="flex rounded-xl border border-white/10 bg-black/30 p-1 text-sm">
            <button onClick={() => setTab("preset")} className={`rounded-lg px-4 py-2 ${tab === "preset" ? "bg-gradient-to-r from-amber-400 to-violet-500 font-bold text-black" : "text-slate-300"}`}>Пресеты</button>
            <button onClick={() => setTab("custom")} className={`rounded-lg px-4 py-2 ${tab === "custom" ? "bg-gradient-to-r from-amber-400 to-violet-500 font-bold text-black" : "text-slate-300"}`}>Свой мир ✍️</button>
          </div>
        </div>

        {tab === "preset" ? (
          <div className="mt-5 grid gap-5 md:grid-cols-[1fr_1fr]">
            <div className="grid gap-2">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { setScenarioId(s.id); setCharIdx(0); }}
                  className={`rounded-xl border p-3 text-left transition ${scenarioId === s.id ? "border-amber-300/60 bg-amber-300/10" : "border-white/10 bg-white/5 hover:bg-white/10"}`}
                >
                  <span className="text-lg">{s.icon}</span> <b className="text-white">{s.title}</b>
                  <span className="ml-2 text-[11px] uppercase tracking-wider text-violet-300">{s.genre}</span>
                  <p className="mt-1 text-[13px] text-slate-300">{s.pitch}</p>
                </button>
              ))}
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
              <p className="text-sm text-slate-400">Сценарий</p>
              <h3 className="text-lg font-bold text-white">{sc.icon} {sc.title} — {sc.worldName}</h3>
              <p className="mt-1 text-[13px] text-slate-300">Квест: {sc.mainQuest}</p>
              <p className="mt-1 text-[13px] text-slate-400">Старт: {sc.startLocation} · Фракции: {sc.factions.join(", ")}</p>
              <p className="mt-3 text-xs uppercase tracking-widest text-slate-400">Выбери персонажа</p>
              <div className="mt-2 grid gap-2">
                {sc.characters.map((c, i) => (
                  <button key={c.name} onClick={() => setCharIdx(i)} className={`rounded-xl border p-3 text-left ${charIdx === i ? "border-emerald-300/60 bg-emerald-300/10" : "border-white/10 bg-white/5"}`}>
                    <b className="text-white">{c.name}</b> <span className="text-xs text-amber-200">· {c.archetype}</span>
                    <p className="text-[12.5px] text-slate-300">{c.backstory}</p>
                    <p className="mt-1 font-mono text-[11px] text-slate-400">{Object.entries(c.stats).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>
                  </button>
                ))}
              </div>
              <button onClick={create} disabled={loading} className="btn-primary mt-4 w-full">{loading ? "Открываем портал…" : "▶ Начать историю"}</button>
            </div>
          </div>
        ) : (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-widest text-amber-200">Мир (свой пресет)</p>
              <input className="input" placeholder="Название истории — напр. «Хроники Солёного Трона»" value={custom.title} onChange={(e) => setCustom({ ...custom, title: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <input className="input" placeholder="Мир: Эверноль" value={custom.worldName} onChange={(e) => setCustom({ ...custom, worldName: e.target.value })} />
                <input className="input" placeholder="Тон: мрачный / уютный" value={custom.tone} onChange={(e) => setCustom({ ...custom, tone: e.target.value })} />
              </div>
              <textarea className="input min-h-24" placeholder="Опиши мир, конфликт, фракции… (это станет каноном)" value={custom.pitch} onChange={(e) => setCustom({ ...custom, pitch: e.target.value })} />
              <input className="input" placeholder="Главный квест героя" value={custom.mainQuest} onChange={(e) => setCustom({ ...custom, mainQuest: e.target.value })} />
            </div>
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-widest text-emerald-200">Герой</p>
              <div className="grid grid-cols-2 gap-3">
                <input className="input" placeholder="Имя" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
                <input className="input" placeholder="Архетип: плут / маг…" value={custom.archetype} onChange={(e) => setCustom({ ...custom, archetype: e.target.value })} />
              </div>
              <textarea className="input min-h-24" placeholder="Предыстория, черты, страхи…" value={custom.backstory} onChange={(e) => setCustom({ ...custom, backstory: e.target.value })} />
              <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-[12.5px] text-slate-400">
                Пустые поля — не страшно: движок достроит мир процедурно, а свободные действия всё равно будут просчитываться по ситуации.
              </div>
              <button onClick={create} disabled={loading} className="btn-primary w-full">{loading ? "Ткём мир…" : "✨ Сотворить мир и начать"}</button>
            </div>
          </div>
        )}
      </div>

      {/* SESSIONS */}
      <div className="card fade-up p-6 md:p-8">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold text-white">📚 Твои кампании</h2>
          <button onClick={refresh} className="btn-ghost text-xs">Обновить</button>
        </div>
        {!sessions.length ? (
          <p className="mt-3 text-sm text-slate-400">Пока пусто — создай первую историю выше. Она появится здесь с номером хода и датой.</p>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {sessions.map((s) => (
              <a key={s.id} href={`/play/${s.id}`} className="rounded-xl border border-white/10 bg-white/5 p-4 hover:bg-white/10">
                <b className="text-white">{s.title}</b>
                <p className="text-xs text-slate-400">{s.scenarioTitle} · ходов: {s.turnCount}</p>
                <p className="mt-1 text-[11px] text-slate-500">{new Date(s.updatedAt).toLocaleString("ru-RU")}</p>
                <span className="mt-2 inline-block rounded-lg bg-gradient-to-r from-amber-400 to-violet-500 px-3 py-1 text-xs font-bold text-black">Продолжить →</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
