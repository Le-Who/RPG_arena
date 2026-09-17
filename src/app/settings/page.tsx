"use client";

import { useEffect, useState } from "react";
import { MODEL_CATALOG, ROUTING_PROFILES, RoutingProfile } from "@/lib/gemini";

type SettingsState = {
  keysMasked: string[];
  keysCount: number;
  envKeysCount: number;
  routingProfile: RoutingProfile;
  narrationModel: string;
  customActionModel: string;
  compactionModel: string;
  fastTaskModel: string;
  useLiveAI: boolean;
  dailyFlashLimit: number;
  dailyLiteLimit: number;
  enforceLimits: boolean;
  embeddingsEnabled: boolean;
  embeddingModel: string;
  embeddingDims: number;
  semanticExtractionEnabled: boolean;
  embeddingModels: string[];
};
type Stats = {
  today?: { totalReq: number; totalTokens: number; errors: number; byModel: Record<string, { requests: number; tokens: number; errors: number; avgLatencyMs: number }>; byTask: Record<string, { requests: number; tokens: number }>; flashReq: number; liteReq: number; embeddingReq: number; perFlashModel: Record<string, { used: number; cap: number }>; liteCap: number };
  quotas?: { flashPerModel: number; liteTotal: number; keyCount: number; enforced: boolean; note: string };
  recent?: { model: string; taskType: string; totalTokens: number; success: boolean; createdAt: string; error: string; latencyMs: number }[];
};

const TASKS: { key: "narrationModel" | "customActionModel" | "compactionModel" | "fastTaskModel"; label: string; hint: string }[] = [
  { key: "narrationModel", label: "Обычный ход (вариант 1/2/3)", hint: "Структурированный ответ с изменениями мира; Lite достаточно" },
  { key: "customActionModel", label: "Свободное действие", hint: "Проверка по профилю до вызова + строгий JSON-контракт" },
  { key: "compactionModel", label: "Компакция памяти", hint: "Сжатие ходов в летопись; старшие модели держат канон" },
  { key: "fastTaskModel", label: "Извлечение фактов (semantic-extractor)", hint: "Асинхронно после хода; факты только с цитатой-доказательством" },
];

export default function SettingsPage() {
  const [s, setS] = useState<SettingsState | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [keysText, setKeysText] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [limits, setLimits] = useState({ flash: 20, lite: 500 });

  async function refresh() {
    const [a, b] = await Promise.all([fetch("/api/settings").then((r) => r.json()), fetch("/api/tokens/stats").then((r) => r.json()).catch(() => null)]);
    setS(a);
    setStats(b);
    setLimits({ flash: a.dailyFlashLimit, lite: a.dailyLiteLimit });
  }
  useEffect(() => {
    refresh();
  }, []);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    setMsg("Сохраняем…");
    try {
      const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const data = await res.json();
      setMsg(data.ok ? `✅ Сохранено (ключей в БД: ${data.keysCount}, из окружения: ${data.envKeysCount})` : `Ошибка: ${data.error ?? "?"}`);
      setKeysText("");
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!s) return <p className="pt-16 text-center text-slate-400">Загружаем настройки…</p>;
  const totalKeys = s.keysCount + s.envKeysCount;
  const liveOn = s.useLiveAI && totalKeys > 0;

  return (
    <div className="space-y-6 pt-8">
      <div className="card fade-up p-6 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-amber-300">Gemini · роутинг · лимиты · память</p>
            <h1 className="mt-1 text-2xl font-black text-white md:text-3xl">⚙️ Центр управления ИИ</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Live Gemini:</span>
            <button onClick={() => save({ useLiveAI: !s.useLiveAI })} disabled={saving || (!s.useLiveAI && totalKeys === 0)} className={`rounded-full px-4 py-2 text-sm font-bold ${liveOn ? "bg-emerald-400 text-black" : "bg-white/10 text-slate-300"}`} title={totalKeys === 0 ? "Сначала добавьте ключ" : ""}>
              {liveOn ? "ВКЛ" : "ВЫКЛ"}
            </button>
          </div>
        </div>
        {msg && <p className="mt-3 text-xs text-amber-200">{msg}</p>}
        <p className="mt-3 text-[13px] text-slate-400">
          Без Live работают только пресеты (офлайн-движок). Свободные кампании, семантический поиск и извлечение фактов требуют ключ. Ключи можно также передать через переменную окружения <code className="text-slate-200">GEMINI_API_KEYS</code> (через запятую) — сейчас из окружения: <b className="text-white">{s.envKeysCount}</b>.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* KEYS */}
        <div className="card p-6">
          <h2 className="text-lg font-extrabold text-white">🔑 Пул ключей AI Studio ({s.keysCount}/10)</h2>
          <p className="mt-1 text-[12.5px] text-slate-400">При ошибке 429/5xx движок пробует следующий ключ, затем следующую модель цепочки. Квоты бесплатного тарифа считаются на ключ.</p>
          <textarea className="input mt-3 min-h-24 font-mono text-xs" placeholder="AIza… (по одному в строке или через запятую)" value={keysText} onChange={(e) => setKeysText(e.target.value)} />
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => save({ keysText, append: true })} disabled={saving || !keysText.trim()} className="btn-primary text-xs">＋ Добавить</button>
            <button onClick={() => save({ clearKeys: true })} disabled={saving || !s.keysCount} className="btn-ghost text-xs">Очистить все</button>
          </div>
          <div className="mt-3 space-y-1">
            {s.keysMasked.map((k, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 font-mono text-xs text-slate-300">
                <span>#{i + 1} {k}</span>
                <button onClick={() => save({ removeIndex: [i] })} className="text-slate-500 hover:text-red-300">✕</button>
              </div>
            ))}
            {!s.keysCount && <p className="text-xs text-slate-500">Ключей в БД нет.</p>}
          </div>
        </div>

        {/* ROUTING */}
        <div className="card p-6">
          <h2 className="text-lg font-extrabold text-white">🧭 Профиль маршрутизации</h2>
          <div className="mt-3 grid gap-2">
            {(Object.keys(ROUTING_PROFILES) as RoutingProfile[]).map((p) => (
              <button key={p} onClick={() => save({ routingProfile: p })} className={`rounded-xl border p-3 text-left ${s.routingProfile === p ? "border-amber-300/60 bg-amber-300/10" : "border-white/10 bg-white/5 hover:bg-white/10"}`}>
                <b className="text-white">{ROUTING_PROFILES[p].title}</b>
                <p className="text-[12px] text-slate-300">{ROUTING_PROFILES[p].desc}</p>
              </button>
            ))}
          </div>
          <div className="mt-4 space-y-2">
            <p className="text-xs uppercase tracking-widest text-slate-400">Матрица задач {s.routingProfile !== "custom" && <span className="normal-case text-slate-500">(редактируется в профиле Custom)</span>}</p>
            {TASKS.map((t) => (
              <div key={t.key} className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
                <div>
                  <b className="text-[13px] text-slate-100">{t.label}</b>
                  <span className="block text-[11px] text-slate-500">{t.hint}</span>
                </div>
                <select className="input w-auto py-1 text-xs" value={s[t.key]} disabled={s.routingProfile !== "custom" || saving} onChange={(e) => save({ routingProfile: "custom", [t.key]: e.target.value })}>
                  {MODEL_CATALOG.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        {/* MEMORY */}
        <div className="card p-6">
          <h2 className="text-lg font-extrabold text-white">🧠 Память: эмбеддинги и извлечение фактов</h2>
          <div className="mt-3 space-y-3 text-[13px]">
            <label className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
              <span>
                <b className="text-slate-100">Семантический поиск (gemini-embedding-2)</b>
                <span className="block text-[11px] text-slate-500">Перед каждым ходом ищутся релевантные воспоминания; новые ноды индексируются в фоне</span>
              </span>
              <input type="checkbox" checked={s.embeddingsEnabled} onChange={(e) => save({ embeddingsEnabled: e.target.checked })} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="rounded-lg bg-white/5 px-3 py-2 text-[12px] text-slate-400">
                Модель
                <select className="input mt-1 py-1 text-xs" value={s.embeddingModel} onChange={(e) => save({ embeddingModel: e.target.value })}>
                  {s.embeddingModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label className="rounded-lg bg-white/5 px-3 py-2 text-[12px] text-slate-400">
                Размерность (MRL)
                <select className="input mt-1 py-1 text-xs" value={s.embeddingDims} onChange={(e) => save({ embeddingDims: Number(e.target.value) })}>
                  {[768, 1536, 3072].map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-[11px] text-slate-500">Смена модели/размерности не ломает старую память: эмбеддинги версионируются по модели и хешу контента; кнопка «переиндексировать» на странице кампании выполнит backfill.</p>
            <label className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
              <span>
                <b className="text-slate-100">Semantic-extractor после хода</b>
                <span className="block text-[11px] text-slate-500">Модель «{s.fastTaskModel}» извлекает факты об NPC, мотивах, обещаниях — только с цитатой из текста</span>
              </span>
              <input type="checkbox" checked={s.semanticExtractionEnabled} onChange={(e) => save({ semanticExtractionEnabled: e.target.checked })} />
            </label>
          </div>
        </div>

        {/* LIMITS */}
        <div className="card p-6">
          <h2 className="text-lg font-extrabold text-white">📊 Лимиты и расход за сегодня</h2>
          <label className="mt-3 flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-[13px]">
            <span>
              <b className="text-slate-100">Соблюдать лимиты на сервере</b>
              <span className="block text-[11px] text-slate-500">Исчерпанные модели пропускаются в цепочке; лимит × число ключей</span>
            </span>
            <input type="checkbox" checked={s.enforceLimits} onChange={(e) => save({ enforceLimits: e.target.checked })} />
          </label>
          <div className="mt-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2 text-[12px] text-slate-400">
            <label>
              Flash / день / ключ
              <input type="number" className="input mt-1 py-1 text-xs" value={limits.flash} onChange={(e) => setLimits({ ...limits, flash: Number(e.target.value) })} />
            </label>
            <label>
              Lite / день / ключ
              <input type="number" className="input mt-1 py-1 text-xs" value={limits.lite} onChange={(e) => setLimits({ ...limits, lite: Number(e.target.value) })} />
            </label>
            <button onClick={() => save({ dailyFlashLimit: limits.flash, dailyLiteLimit: limits.lite })} className="btn-ghost text-xs">Сохранить</button>
          </div>
          {stats?.today && (
            <div className="mt-4 space-y-2 text-[12.5px]">
              <p className="text-slate-300">
                Запросов: <b className="text-white">{stats.today.totalReq}</b> · токенов: <b className="text-white">{stats.today.totalTokens.toLocaleString("ru-RU")}</b> · ошибок: <b className={stats.today.errors ? "text-red-300" : "text-white"}>{stats.today.errors}</b> · эмбеддинг-вызовов: <b className="text-white">{stats.today.embeddingReq}</b>
              </p>
              {Object.entries(stats.today.perFlashModel).map(([m, v]) => (
                <div key={m}>
                  <div className="flex justify-between text-[11px] text-slate-400"><span>{m}</span><span>{v.used}/{v.cap}</span></div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className={`h-full ${v.used >= v.cap ? "bg-red-400" : "bg-violet-400"}`} style={{ width: `${Math.min(100, (v.used / Math.max(1, v.cap)) * 100)}%` }} /></div>
                </div>
              ))}
              <div>
                <div className="flex justify-between text-[11px] text-slate-400"><span>gemini-3.5-flash-lite</span><span>{stats.today.liteReq}/{stats.today.liteCap}</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-emerald-400" style={{ width: `${Math.min(100, (stats.today.liteReq / Math.max(1, stats.today.liteCap)) * 100)}%` }} /></div>
              </div>
              <p className="text-[11px] text-slate-500">{stats.quotas?.note}</p>
              <details className="rounded-lg bg-black/30 p-2">
                <summary className="cursor-pointer text-[12px] text-slate-300">Последние вызовы</summary>
                <div className="mt-1 space-y-1 font-mono text-[10.5px]">
                  {stats.recent?.map((r, i) => (
                    <div key={i} className={`flex justify-between gap-2 ${r.success ? "text-slate-400" : "text-red-300"}`}>
                      <span className="truncate">{new Date(r.createdAt).toLocaleTimeString("ru-RU")} {r.model} · {r.taskType}</span>
                      <span className="shrink-0">{r.latencyMs}ms · {r.totalTokens}t{r.error ? ` · ${r.error.slice(0, 40)}` : ""}</span>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
