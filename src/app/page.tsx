"use client";

import { useEffect, useState } from "react";
import { ARCHETYPES, SCENARIOS, TONE_PRESETS } from "@/lib/scenarios";
import { PROFILE_SPECS, RULES_PROFILE_IDS } from "@/lib/profiles";
import type { RulesProfile } from "@/db/schema";

type Session = { id: string; title: string; scenarioTitle: string; turnCount: number; status: string; updatedAt: string; campaignMode: string; rulesProfile: string };
const STAT_KEYS = ["СИЛ", "ЛОВ", "ВЫН", "ИНТ", "МУД", "ХАР"];

export default function HomePage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [ai, setAi] = useState<{ keysCount: number; envKeysCount: number; useLiveAI: boolean } | null>(null);
  const [tab, setTab] = useState<"preset" | "free">("preset");
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const [charIdx, setCharIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [rulesProfile, setRulesProfile] = useState<RulesProfile>("narrative");
  const [custom, setCustom] = useState({ title: "", worldName: "", pitch: "", mainQuest: "", tone: "", era: "", startLocation: "", factions: "", name: "", archetype: "", backstory: "", skills: "", traits: "", startItems: "" });
  const [stats, setStats] = useState<Record<string, number>>({ СИЛ: 12, ЛОВ: 13, ВЫН: 12, ИНТ: 12, МУД: 13, ХАР: 12 });

  const sc = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];
  const liveOn = Boolean(ai?.useLiveAI && (ai?.keysCount ?? 0) + (ai?.envKeysCount ?? 0) > 0);

  async function refresh() {
    const [a, c] = await Promise.all([
      fetch("/api/sessions").then((r) => r.json()).catch(() => ({ sessions: [] })),
      fetch("/api/settings").then((r) => r.json()).catch(() => null),
    ]);
    setSessions(a.sessions ?? []);
    setAi(c);
  }
  useEffect(() => {
    refresh();
  }, []);

  const list = (s: string) => s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

  async function create() {
    setLoading(true);
    try {
      const body =
        tab === "preset"
          ? { mode: "preset", scenarioId, characterIndex: charIdx }
          : {
              mode: "free",
              rulesProfile,
              customScenario: { title: custom.title, worldName: custom.worldName, pitch: custom.pitch, mainQuest: custom.mainQuest, tone: custom.tone, era: custom.era, startLocation: custom.startLocation, factions: list(custom.factions) },
              customCharacter: { name: custom.name, archetype: custom.archetype, backstory: custom.backstory, stats, skills: list(custom.skills), traits: list(custom.traits), startItems: list(custom.startItems) },
            };
      const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.session) window.location.href = `/play/${data.session.id}`;
    } finally {
      setLoading(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Удалить кампанию безвозвратно?")) return;
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    refresh();
  }

  return (
    <div className="space-y-6 pt-8">
      {/* HERO */}
      <div className="card fade-up overflow-hidden">
        <div className="grid gap-6 p-6 md:grid-cols-[1.2fr_0.8fr] md:p-10">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-amber-300/90">Интерактивная новелла · Любой жанр · Свобода действия</p>
            <h1 className="mt-2 text-3xl font-black leading-[1.05] text-white md:text-5xl">
              История, которая <span className="bg-gradient-to-r from-amber-300 to-violet-400 bg-clip-text text-transparent">помнит твои решения</span>
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-slate-300">
              Нуар, космос, хоррор, бытовая драма или классическая героика — выбери авторский пресет или задай свой мир. Мастер-ИИ ведёт сцену, а сервер проверяет и применяет каждое изменение мира:
              предметы, места, отношения, цели. <b className="text-white">Механику выбираешь ты</b>: d20, лёгкие риск-проверки или чистый нарратив.
            </p>
            <div className="mt-5 flex flex-wrap gap-2 text-sm">
              <a href="#new" className="btn-primary">▶ Начать историю</a>
              <a href="/settings" className="btn-ghost">⚙️ Настройки ИИ</a>
            </div>
            <div className="mt-5 flex flex-wrap gap-2 text-[12px]">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">🧠 Память с проверяемым происхождением</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">🔎 Семантический поиск по канону</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">🛡 Сервер валидирует изменения мира</span>
              <span className={`rounded-full border px-3 py-1 ${liveOn ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-200" : "border-amber-300/30 bg-amber-300/10 text-amber-200"}`}>{liveOn ? "● ИИ-мастер на связи" : "● Автономный режим (только пресеты)"}</span>
            </div>
          </div>
          <div className="grid content-start gap-3">
            <div className="rounded-2xl border border-white/10 bg-black/40 p-4">
              <p className="text-xs uppercase tracking-widest text-slate-400">Как устроена игра</p>
              <ol className="mt-2 space-y-2 text-[13px] text-slate-300">
                <li>🎭 <b className="text-white">Мастер</b> описывает сцену в тоне твоего мира</li>
                <li>🖐️ <b className="text-white">Ты</b> выбираешь вариант или пишешь любое действие</li>
                <li>⚖️ <b className="text-white">Сервер</b> делает проверку по выбранной механике — до ответа ИИ</li>
                <li>🛡 <b className="text-white">Изменения мира</b> валидируются: нельзя использовать то, чего нет</li>
                <li>📜 <b className="text-white">Память</b> строится из подтверждённых фактов и находится по смыслу</li>
              </ol>
            </div>
            <div className="rounded-2xl border border-violet-300/20 bg-violet-500/10 p-4 text-[13px] text-violet-100">
              💡 Свободные кампании ведёт только ИИ: без ключа Gemini они честно скажут «нужен мастер», а не подсунут шаблон. Пресеты работают и офлайн.
            </div>
          </div>
        </div>
      </div>

      {/* NEW GAME */}
      <div id="new" className="card fade-up p-6 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-extrabold text-white">✨ Новая кампания</h2>
          <div className="flex rounded-xl border border-white/10 bg-black/30 p-1 text-sm">
            <button onClick={() => setTab("preset")} className={`rounded-lg px-4 py-2 ${tab === "preset" ? "bg-gradient-to-r from-amber-400 to-violet-500 font-bold text-black" : "text-slate-300"}`}>📚 Пресеты</button>
            <button onClick={() => setTab("free")} className={`rounded-lg px-4 py-2 ${tab === "free" ? "bg-gradient-to-r from-amber-400 to-violet-500 font-bold text-black" : "text-slate-300"}`}>✍️ Свободная история</button>
          </div>
        </div>

        {tab === "preset" ? (
          <div className="mt-5 grid gap-5 md:grid-cols-[1fr_1fr]">
            <div className="grid gap-2">
              {SCENARIOS.map((s) => (
                <button key={s.id} onClick={() => { setScenarioId(s.id); setCharIdx(0); }} className={`rounded-xl border p-3 text-left transition ${scenarioId === s.id ? "border-amber-300/60 bg-amber-300/10" : "border-white/10 bg-white/5 hover:bg-white/10"}`}>
                  <span className="text-lg">{s.icon}</span> <b className="text-white">{s.title}</b>
                  <span className="ml-2 text-[11px] uppercase tracking-wider text-violet-300">{s.genre}</span>
                  <span className="ml-2 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-300">{PROFILE_SPECS[s.rulesProfile].short}</span>
                  <p className="mt-1 text-[13px] text-slate-300">{s.pitch}</p>
                </button>
              ))}
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
              <p className="text-sm text-slate-400">Сценарий</p>
              <h3 className="text-lg font-bold text-white">{sc.icon} {sc.title} — {sc.worldName}</h3>
              <p className="mt-1 text-[13px] text-slate-300">Цель: {sc.mainQuest}</p>
              <p className="mt-1 text-[13px] text-slate-400">Старт: {sc.startLocation} · Фракции: {sc.factions.join(", ")}</p>
              <p className="mt-1 text-[12px] text-violet-200">Механика пресета: {PROFILE_SPECS[sc.rulesProfile].label} — {PROFILE_SPECS[sc.rulesProfile].description}</p>
              <p className="mt-3 text-xs uppercase tracking-widest text-slate-400">Выбери персонажа</p>
              <div className="mt-2 grid gap-2">
                {sc.characters.map((c, i) => (
                  <button key={c.name} onClick={() => setCharIdx(i)} className={`rounded-xl border p-3 text-left ${charIdx === i ? "border-emerald-300/60 bg-emerald-300/10" : "border-white/10 bg-white/5"}`}>
                    <b className="text-white">{c.name}</b> <span className="text-xs text-amber-200">· {c.archetype}</span>
                    <p className="text-[12.5px] text-slate-300">{c.backstory}</p>
                    {sc.rulesProfile === "d20" && <p className="mt-1 font-mono text-[11px] text-slate-400">{Object.entries(c.stats).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>}
                    <p className="text-[11px] text-slate-500">{c.skills.join(" · ")} · {c.traits.join(" · ")}</p>
                  </button>
                ))}
              </div>
              <button onClick={create} disabled={loading} className="btn-primary mt-4 w-full">{loading ? "Открываем…" : "▶ Начать историю"}</button>
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-5">
            {!liveOn && (
              <div className="rounded-xl border border-amber-300/30 bg-amber-400/10 p-3 text-[13px] text-amber-100">
                Свободная история ведётся только ИИ-мастером. Добавьте ключ Gemini и включите Live в <a className="underline" href="/settings">настройках</a> — иначе ходы будут отклонены с понятным сообщением.
              </div>
            )}
            <div>
              <p className="text-xs uppercase tracking-widest text-violet-200">Механика</p>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                {RULES_PROFILE_IDS.map((id) => {
                  const p = PROFILE_SPECS[id];
                  return (
                    <button key={id} onClick={() => setRulesProfile(id)} className={`rounded-xl border p-3 text-left ${rulesProfile === id ? "border-violet-300/60 bg-violet-400/10" : "border-white/10 bg-white/5 hover:bg-white/10"}`}>
                      <b className="text-white">{p.label}</b>
                      <p className="mt-1 text-[12px] text-slate-300">{p.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <p className="text-xs uppercase tracking-widest text-amber-200">Мир</p>
                <input className="input" placeholder="Название истории — «Последний рейс „Кассиопеи“»" value={custom.title} onChange={(e) => setCustom({ ...custom, title: e.target.value })} />
                <div className="grid grid-cols-2 gap-3">
                  <input className="input" placeholder="Мир / место: Ленинград, 1983" value={custom.worldName} onChange={(e) => setCustom({ ...custom, worldName: e.target.value })} />
                  <input className="input" placeholder="Эпоха / сеттинг" value={custom.era} onChange={(e) => setCustom({ ...custom, era: e.target.value })} />
                </div>
                <input className="input" list="tones" placeholder="Тон: нуар / уютный / триллер…" value={custom.tone} onChange={(e) => setCustom({ ...custom, tone: e.target.value })} />
                <datalist id="tones">{TONE_PRESETS.map((t) => <option key={t} value={t} />)}</datalist>
                <textarea className="input min-h-28" placeholder="Опиши мир, конфликт, действующие силы — это станет каноном, которому ИИ будет следовать" value={custom.pitch} onChange={(e) => setCustom({ ...custom, pitch: e.target.value })} />
                <input className="input" placeholder="Главная цель героя" value={custom.mainQuest} onChange={(e) => setCustom({ ...custom, mainQuest: e.target.value })} />
                <div className="grid grid-cols-2 gap-3">
                  <input className="input" placeholder="Стартовая точка: «Кухня коммуналки»" value={custom.startLocation} onChange={(e) => setCustom({ ...custom, startLocation: e.target.value })} />
                  <input className="input" placeholder="Фракции/силы через запятую" value={custom.factions} onChange={(e) => setCustom({ ...custom, factions: e.target.value })} />
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-xs uppercase tracking-widest text-emerald-200">Герой</p>
                <div className="grid grid-cols-2 gap-3">
                  <input className="input" placeholder="Имя" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
                  <input className="input" list="archetypes" placeholder="Кто он/она: следователь, инженер…" value={custom.archetype} onChange={(e) => setCustom({ ...custom, archetype: e.target.value })} />
                  <datalist id="archetypes">{ARCHETYPES.map((a) => <option key={a} value={a} />)}</datalist>
                </div>
                <textarea className="input min-h-20" placeholder="Предыстория, мотивы, что скрывает" value={custom.backstory} onChange={(e) => setCustom({ ...custom, backstory: e.target.value })} />
                <div className="grid grid-cols-2 gap-3">
                  <input className="input" placeholder="Навыки через запятую" value={custom.skills} onChange={(e) => setCustom({ ...custom, skills: e.target.value })} />
                  <input className="input" placeholder="Черты через запятую" value={custom.traits} onChange={(e) => setCustom({ ...custom, traits: e.target.value })} />
                </div>
                <input className="input" placeholder="Что с собой (через запятую): блокнот, фонарик…" value={custom.startItems} onChange={(e) => setCustom({ ...custom, startItems: e.target.value })} />
                {PROFILE_SPECS[rulesProfile].resources.stats && (
                  <div>
                    <p className="text-[11px] text-slate-400">Характеристики (3–20)</p>
                    <div className="mt-1 grid grid-cols-6 gap-1.5">
                      {STAT_KEYS.map((k) => (
                        <label key={k} className="rounded-lg bg-white/5 p-1.5 text-center font-mono text-[11px] text-slate-300">
                          {k}
                          <input type="number" min={3} max={20} className="mt-1 w-full rounded bg-black/40 px-1 py-0.5 text-center text-white" value={stats[k]} onChange={(e) => setStats({ ...stats, [k]: Number(e.target.value) })} />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <button onClick={create} disabled={loading} className="btn-primary w-full">{loading ? "Открываем…" : "▶ Начать свободную историю"}</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* SESSIONS */}
      <div className="card fade-up p-6">
        <h2 className="text-lg font-extrabold text-white">📚 Твои кампании</h2>
        {!sessions.length && <p className="mt-2 text-sm text-slate-400">Пока нет ни одной. Начни первую выше.</p>}
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
              <a href={`/play/${s.id}`} className="min-w-0 flex-1">
                <b className="block truncate text-white">{s.title}</b>
                <span className="text-[12px] text-slate-400">
                  {s.scenarioTitle} · {s.campaignMode === "preset" ? "пресет" : "свободная"} · {PROFILE_SPECS[s.rulesProfile as RulesProfile]?.short ?? s.rulesProfile} · ход {s.turnCount} · {new Date(s.updatedAt).toLocaleString("ru-RU")}
                </span>
              </a>
              <button onClick={() => remove(s.id)} className="text-xs text-slate-500 hover:text-red-300" title="Удалить">✕</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
