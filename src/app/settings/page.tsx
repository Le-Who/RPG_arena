"use client";

import { useEffect, useState } from "react";
import { MODEL_CATALOG, ROUTING_PROFILES, RoutingProfile } from "@/lib/gemini";

type SettingsState = {
  keysMasked: string[];
  keysCount: number;
  routingProfile: RoutingProfile;
  narrationModel: string;
  customActionModel: string;
  compactionModel: string;
  fastTaskModel: string;
  primaryModel: string;
  fallbackChain: string[];
  useLiveAI: boolean;
  dailyFlashLimit: number;
  dailyLiteLimit: number;
};

export default function SettingsPage() {
  const [s, setS] = useState<SettingsState | null>(null);
  const [keysText, setKeysText] = useState("");
  const [stats, setStats] = useState<{
    today?: {
      totalReq: number;
      totalTokens: number;
      byModel: Record<string, { requests: number; tokens: number; errors: number }>;
      byTask: Record<string, { requests: number; tokens: number }>;
      flashReq: number;
      liteReq: number;
      perFlashModel: Record<string, number>;
    };
    quotas?: { flashPerModel: number; liteTotal: number };
    recent?: { model: string; taskType: string; totalTokens: number; success: boolean; createdAt: string; error: string }[];
  } | null>(null);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const [a, b] = await Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/tokens/stats").then((r) => r.json()).catch(() => null),
    ]);
    setS(a);
    setStats(b);
  }
  useEffect(() => { refresh(); }, []);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    setMsg("Сохраняем…");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      setMsg(data.ok ? `✅ Настройки сохранены (ключей: ${data.keysCount})` : "Ошибка при сохранении");
      setKeysText("");
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 pt-8">
      {/* HEADER */}
      <div className="card fade-up p-6 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-amber-300">Маршрутизация Gemini · Квоты 20 / 500</p>
            <h1 className="mt-1 text-2xl font-black text-white md:text-3xl">⚙️ Настройки моделей и ключей AI Studio</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Live Gemini:</span>
            <button
              onClick={() => save({ useLiveAI: !s?.useLiveAI })}
              className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
                s?.useLiveAI ? "bg-emerald-400 text-black shadow-lg shadow-emerald-500/20" : "bg-white/10 text-slate-300"
              }`}
            >
              {s?.useLiveAI ? "● LIVE ВКЛ" : "○ ОФЛАЙН"}
            </button>
          </div>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-300">
          Управляйте распределением нагрузки: используйте <b className="text-emerald-300">Flash-Lite (500 запросов/день)</b> для
          нарратива и рутинных ходов, сохраняя драгоценный лимит <b className="text-amber-300">Flash 3.8 (20 запросов/день)</b> для
          глубокого сжатия памяти (Memory House) и свободных действий игрока.
        </p>
        {msg && <p className="mt-3 rounded-lg bg-emerald-400/10 px-3 py-2 text-xs font-medium text-emerald-300">{msg}</p>}
      </div>

      {/* STRATEGY PROFILES */}
      <div className="card fade-up p-6 md:p-8">
        <h2 className="text-lg font-extrabold text-white">🎯 Профили маршрутизации моделей</h2>
        <p className="mt-1 text-xs text-slate-400">Выберите готовый пресет или настройте каждую модель вручную:</p>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {(["balanced", "economy", "flagship"] as RoutingProfile[]).map((pKey) => {
            const p = ROUTING_PROFILES[pKey];
            const active = s?.routingProfile === pKey;
            return (
              <button
                key={pKey}
                onClick={() => save({ routingProfile: pKey })}
                disabled={saving}
                className={`rounded-2xl border p-4 text-left transition ${
                  active
                    ? "border-amber-300/80 bg-gradient-to-b from-amber-300/15 to-violet-500/10 shadow-lg"
                    : "border-white/10 bg-white/5 hover:bg-white/10"
                }`}
              >
                <div className="flex items-center justify-between">
                  <b className="text-sm text-white">{p.title}</b>
                  {active && <span className="rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold text-black">АКТИВЕН</span>}
                </div>
                <p className="mt-2 text-[12.5px] leading-relaxed text-slate-300">{p.desc}</p>
                <div className="mt-3 space-y-1 rounded-xl bg-black/30 p-2.5 font-mono text-[11px]">
                  <div className="flex justify-between text-slate-300">
                    <span className="text-slate-400">Нарратив (ходы 1/2/3):</span>
                    <span className="text-emerald-300">{p.config.narrationModel.replace("gemini-", "")}</span>
                  </div>
                  <div className="flex justify-between text-slate-300">
                    <span className="text-slate-400">Свободный ввод:</span>
                    <span className="text-amber-200">{p.config.customActionModel.replace("gemini-", "")}</span>
                  </div>
                  <div className="flex justify-between text-slate-300">
                    <span className="text-slate-400">Компакция памяти:</span>
                    <span className="text-violet-300">{p.config.compactionModel.replace("gemini-", "")}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* CUSTOM MATRIX ACCORDION */}
        <div className="mt-5 rounded-2xl border border-white/10 bg-black/30 p-4">
          <div className="flex items-center justify-between">
            <div>
              <b className="text-sm text-white">⚙️ Ручное назначение моделей (Custom)</b>
              <p className="text-xs text-slate-400">Точечно выберите модель для каждого типа игровой задачи:</p>
            </div>
            {s?.routingProfile === "custom" && (
              <span className="rounded-full bg-violet-400/20 px-2.5 py-1 text-[11px] font-bold text-violet-200">Режим Custom</span>
            )}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            {/* Narration model */}
            <div className="space-y-1.5 rounded-xl border border-white/5 bg-white/5 p-3">
              <span className="font-semibold text-slate-200">📖 Обычный нарратив (варианты 1/2/3)</span>
              <p className="text-[11px] text-slate-400">Рекомендуется Lite (500/день)</p>
              <select
                value={s?.narrationModel ?? "gemini-3.5-flash-lite"}
                onChange={(e) => save({ routingProfile: "custom", narrationModel: e.target.value })}
                className="input py-1.5 text-xs"
              >
                {MODEL_CATALOG.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({m.family === "lite" ? "500/д" : "20/д"})</option>
                ))}
              </select>
            </div>

            {/* Custom action model */}
            <div className="space-y-1.5 rounded-xl border border-white/5 bg-white/5 p-3">
              <span className="font-semibold text-slate-200">🖐️ Свободный ввод (Custom Action)</span>
              <p className="text-[11px] text-slate-400">Рекомендуется 3.8 / 3.7 Flash</p>
              <select
                value={s?.customActionModel ?? "gemini-3.8-flash"}
                onChange={(e) => save({ routingProfile: "custom", customActionModel: e.target.value })}
                className="input py-1.5 text-xs"
              >
                {MODEL_CATALOG.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({m.family === "lite" ? "500/д" : "20/д"})</option>
                ))}
              </select>
            </div>

            {/* Compaction model */}
            <div className="space-y-1.5 rounded-xl border border-white/5 bg-white/5 p-3">
              <span className="font-semibold text-slate-200">🧠 Компакция Memory House</span>
              <p className="text-[11px] text-slate-400">Флагманы 3.8 / 3.7 (сохранение канона)</p>
              <select
                value={s?.compactionModel ?? "gemini-3.8-flash"}
                onChange={(e) => save({ routingProfile: "custom", compactionModel: e.target.value })}
                className="input py-1.5 text-xs"
              >
                {MODEL_CATALOG.filter((m) => m.family === "flash").map((m) => (
                  <option key={m.id} value={m.id}>{m.name} (20/д)</option>
                ))}
              </select>
            </div>

            {/* Fast task model */}
            <div className="space-y-1.5 rounded-xl border border-white/5 bg-white/5 p-3">
              <span className="font-semibold text-slate-200">⚡ Извлечение фактов и лута</span>
              <p className="text-[11px] text-slate-400">Быстрый Lite 3.5</p>
              <select
                value={s?.fastTaskModel ?? "gemini-3.5-flash-lite"}
                onChange={(e) => save({ routingProfile: "custom", fastTaskModel: e.target.value })}
                className="input py-1.5 text-xs"
              >
                {MODEL_CATALOG.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* KEYS MANAGEMENT */}
      <div className="card fade-up p-6 md:p-8">
        <h2 className="text-lg font-extrabold text-white">🔑 Ключи Google AI Studio</h2>
        <p className="mt-1 text-xs text-slate-400">
          Вставьте 1 или несколько ключей (через запятую или новую строку). При 429/исчерпании квоты движок автоматически
          переключается на следующий ключ или модель в цепочке:
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <textarea
              className="input min-h-24 font-mono text-xs"
              placeholder="AIzaSy...key1, AIzaSy...key2"
              value={keysText}
              onChange={(e) => setKeysText(e.target.value)}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={() => save({ keysText, append: true })} disabled={saving || !keysText.trim()} className="btn-primary text-xs">
                ＋ Добавить к списку
              </button>
              <button onClick={() => save({ keysText, append: false })} disabled={saving || !keysText.trim()} className="btn-ghost text-xs">
                ⟲ Заменить все
              </button>
              <button onClick={() => save({ clearKeys: true })} disabled={saving || !s?.keysCount} className="btn-ghost text-xs text-red-300">
                🗑 Очистить ключи
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
            <p className="text-xs uppercase tracking-widest text-slate-400">Активные ключи ({s?.keysCount ?? 0})</p>
            <div className="mt-2 max-h-36 space-y-1.5 overflow-y-auto scroll-thin">
              {(s?.keysMasked ?? []).map((k, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 font-mono text-xs text-slate-300">
                  <span>🔑 Ключ #{i + 1}: <span className="text-amber-200">{k}</span></span>
                  <button onClick={() => save({ removeIndex: [i] })} className="text-[11px] text-red-400 hover:text-red-300">
                    Удалить
                  </button>
                </div>
              ))}
              {!s?.keysCount && (
                <p className="text-xs text-slate-500">Ключей нет — игра работает на встроенном офлайн-движке без потери прогресса.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* MONITORING & QUOTAS */}
      <div className="card fade-up p-6 md:p-8">
        <h2 className="text-lg font-extrabold text-white">📊 Мониторинг расхода токенов и квот (за сегодня)</h2>
        <p className="mt-1 text-xs text-slate-400">Учитывает все вызовы: нарратив, разрешение, компакцию и фолбэки:</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
            <p className="text-[11px] uppercase tracking-widest text-slate-400">Всего вызовов</p>
            <p className="mt-1 text-2xl font-black text-white">{stats?.today?.totalReq ?? 0}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
            <p className="text-[11px] uppercase tracking-widest text-slate-400">Токенов сегодня</p>
            <p className="mt-1 text-2xl font-black text-amber-200">{(stats?.today?.totalTokens ?? 0).toLocaleString("ru-RU")}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
            <p className="text-[11px] uppercase tracking-widest text-slate-400">Flash (лимит 60)</p>
            <p className="mt-1 text-2xl font-black text-violet-200">{stats?.today?.flashReq ?? 0} <span className="text-xs text-slate-400">/ 60</span></p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 p-3.5">
            <p className="text-[11px] uppercase tracking-widest text-slate-400">Lite (лимит 500)</p>
            <p className="mt-1 text-2xl font-black text-emerald-200">{stats?.today?.liteReq ?? 0} <span className="text-xs text-slate-400">/ 500</span></p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {/* By model stats */}
          <div className="rounded-xl border border-white/10 bg-black/30 p-4">
            <p className="text-xs uppercase tracking-widest text-slate-400">Расход по моделям</p>
            <div className="mt-2 space-y-2.5">
              {Object.entries(stats?.today?.byModel ?? {}).map(([m, v]) => {
                const limit = m.includes("lite") ? 500 : 20;
                const pct = Math.min(100, Math.round((v.requests / limit) * 100));
                return (
                  <div key={m}>
                    <div className="flex justify-between font-mono text-[11.5px] text-slate-300">
                      <span>{m}</span>
                      <span>{v.requests}/{limit} req ({pct}%) · {v.tokens.toLocaleString("ru-RU")} tok</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div
                        className={`h-full rounded-full ${
                          pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-emerald-400"
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              {!Object.keys(stats?.today?.byModel ?? {}).length && (
                <p className="text-xs text-slate-500">Вызовов пока не было.</p>
              )}
            </div>
          </div>

          {/* Recent logs */}
          <div className="rounded-xl border border-white/10 bg-black/30 p-4">
            <p className="text-xs uppercase tracking-widest text-slate-400">Последние логи вызовов</p>
            <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto scroll-thin text-[11.5px]">
              {(stats?.recent ?? []).map((r, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg bg-white/5 px-2.5 py-1.5 text-slate-300">
                  <span className="font-mono">{r.model.replace("gemini-", "")} · {r.taskType}</span>
                  <span className={r.success ? "text-emerald-300 font-mono" : "text-red-300"}>
                    {r.success ? `${r.totalTokens} tok` : `ERR`}
                  </span>
                </div>
              ))}
              {!(stats?.recent ?? []).length && <p className="text-xs text-slate-500">Лог пуст.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
