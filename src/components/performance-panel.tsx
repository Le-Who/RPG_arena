"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge, LoaderCircle, MonitorSmartphone, RefreshCw, ScrollText, Timer } from "lucide-react";
import { api } from "@/lib/api-client";
import type { PerformanceReport } from "@/lib/performance-store";
import type { Rating, Summary } from "@/lib/performance-report";

const RATING_LABELS: Record<Rating, string> = { good: "Хорошо", "needs-improvement": "Можно лучше", poor: "Плохо", unknown: "Нет данных" };
const FEW_SAMPLES = 20;
type Unit = "ms" | "" | "count";

function format(value: number, unit: Unit): string {
  if (unit === "ms") return value >= 10_000 ? `${(value / 1000).toFixed(1)} с` : `${Math.round(value)} мс`;
  if (unit === "") return value.toFixed(value >= 1 ? 2 : 3);
  return Math.round(value).toLocaleString("ru-RU");
}

function SummaryTable({ caption, rows, unit, empty }: { caption: string; rows: { key: string; label: string; summary: Summary }[]; unit: Unit; empty: string }) {
  const measured = rows.filter((row) => row.summary.count > 0);
  if (!measured.length) return empty ? <p className="perf-empty">{empty}</p> : null;
  return <div className="perf-table-wrap" tabIndex={0} role="region" aria-label={caption}><table className="perf-table">
    <caption className="perf-caption">{caption}</caption>
    <thead><tr><th scope="col">Показатель</th><th scope="col">n</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">max</th></tr></thead>
    <tbody>{measured.map((row) => <tr key={row.key}>
      <th scope="row">{row.label}{row.summary.count < FEW_SAMPLES && <span className="perf-few">мало данных</span>}</th>
      <td>{row.summary.count}</td><td>{format(row.summary.p50, unit)}</td><td>{format(row.summary.p95, unit)}</td><td>{format(row.summary.max, unit)}</td>
    </tr>)}</tbody>
  </table></div>;
}

/** Administrative view of anonymous field data (PERF-1/4), stored turn stages (PERF-2) and prompt size (NARR-12). */
export function PerformancePanel() {
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const load = useCallback(async (windowDays: number) => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const next = await api<PerformanceReport>(`/api/system/performance?days=${windowDays}`);
      if (version === requestVersion.current) { setReport(next); setError(""); }
    }
    catch (e) { if (version === requestVersion.current) setError(e instanceof Error ? e.message : "Не удалось получить замеры"); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(days), 0); return () => window.clearTimeout(timer); }, [load, days]);
  const prompt = report?.turns.prompt;
  const maxShare = Math.max(1, ...(prompt?.sections.map((section) => section.share) ?? [1]));
  return <section className="perf-panel" aria-labelledby="perf-title" aria-busy={loading}>
    <div className="perf-heading">
      <div><div className="eyebrow">PERF-1 · PERF-2 · PERF-4 · NARR-12</div><h2 id="perf-title">Скорость и бюджет промпта</h2>
        <p>Добровольно включённый сбор замеров production-сборки и метрики сохранённых ходов. Выборка ограничена и не равна всем посещениям; решения об оптимизации требуют достаточного числа замеров.</p></div>
      <div className="perf-actions">
        <label className="perf-window">Окно замеров<select value={days} onChange={(event) => setDays(Number(event.target.value))}>{[1, 7, 14].map((value) => <option key={value} value={value}>{value === 1 ? "1 день" : `${value} дней`}</option>)}</select></label>
        <button type="button" className="button secondary" onClick={() => void load(days)} disabled={loading}><RefreshCw size={14} />Обновить</button>
      </div>
    </div>
    {error && <div className="notice error-notice" role="alert"><p>{error}</p></div>}
    {!report ? loading && <div className="perf-loading" role="status"><LoaderCircle size={18} className="spin" />Читаем замеры…</div> : <>
      {!report.telemetryEnabled && <div className="notice"><p>Сбор браузерных замеров выключен по умолчанию. Для включения: CHRONICLE_TELEMETRY_ENABLED=1. Метрики ходов доступны независимо от сбора.</p></div>}
      <p className="perf-note">Показаны последние {report.sampleLimit.toLocaleString("ru-RU")} браузерных замеров и до {report.turnLimit} ходов в выбранных окнах. Web Vitals относятся к исходному документу, а не к каждому переходу внутри приложения.</p>
      <h3 className="perf-subtitle"><Gauge size={16} />Web Vitals · оценка по p75 · {report.vitals.totalSamples} замеров за {report.windowDays} дн.</h3>
      <div className="perf-grid">{report.vitals.vitals.map((vital) => <article key={vital.metric} className="perf-card" data-rating={vital.rating}>
        <header><strong>{vital.metric}</strong><span className="perf-rating">{RATING_LABELS[vital.rating]}</span></header>
        <div className="perf-value">{vital.summary.count ? format(vital.summary.p75, vital.unit) : "—"}<small>p75</small></div>
        <p>{vital.label}</p>
        <dl>
          <div><dt>p50</dt><dd>{vital.summary.count ? format(vital.summary.p50, vital.unit) : "—"}</dd></div>
          <div><dt>p95</dt><dd>{vital.summary.count ? format(vital.summary.p95, vital.unit) : "—"}</dd></div>
          <div><dt>n</dt><dd>{vital.summary.count}</dd></div>
        </dl>
        <small className="perf-note">Хорошо ≤ {format(vital.thresholds.good, vital.unit)}, плохо &gt; {format(vital.thresholds.poor, vital.unit)}{vital.summary.count > 0 && vital.summary.count < FEW_SAMPLES ? " · мало данных" : ""}</small>
        {(vital.devices.mobile.count > 0 || vital.devices.desktop.count > 0) && <small className="perf-note"><MonitorSmartphone size={12} aria-hidden="true" />телефон p75 {vital.devices.mobile.count ? format(vital.devices.mobile.p75, vital.unit) : "—"} · компьютер p75 {vital.devices.desktop.count ? format(vital.devices.desktop.p75, vital.unit) : "—"}</small>}
        {vital.routes.length > 0 && <small className="perf-note">Маршруты: {vital.routes.map((route) => `${route.route} (${route.count})`).join(", ")}</small>}
      </article>)}</div>
      <h3 className="perf-subtitle"><Timer size={16} />Первый экран и ход глазами игрока</h3>
      <SummaryTable caption="Тайминги первого экрана и хода в браузере" rows={report.vitals.timings.map((timing) => ({ key: timing.metric, label: timing.label, summary: timing.summary }))} unit="ms" empty="Браузерных таймингов пока нет: они появляются после посещений production-сборки." />
      <h3 className="perf-subtitle"><Timer size={16} />Этапы хода на сервере · {report.turns.timedTurns} из {report.turns.turns} ходов за {report.turnWindowDays} дн.</h3>
      <SummaryTable caption="Этапы хода на сервере" rows={report.turns.stages.map((stage) => ({ key: stage.key, label: stage.label, summary: stage.summary }))} unit="ms" empty="Сохранённых ходов с метриками пока нет." />
      {report.turns.attempts.count > 0 && <p className="perf-note">Попыток генерации на ход: p50 {report.turns.attempts.p50.toFixed(1)}, p95 {report.turns.attempts.p95.toFixed(1)}, максимум {report.turns.attempts.max}.</p>}
      <h3 className="perf-subtitle"><ScrollText size={16} />Бюджет промпта · ходов с замером: {prompt?.measuredTurns ?? 0}</h3>
      {prompt && prompt.measuredTurns > 0 ? <>
        <SummaryTable caption="Размер промпта в символах" unit="count" empty="" rows={[
          { key: "system", label: "Системная часть, символов", summary: prompt.systemChars },
          { key: "user", label: "Пользовательская часть, символов", summary: prompt.userChars },
          { key: "schema", label: "Схема ответа, символов", summary: prompt.schemaChars },
          { key: "tokens", label: "Оценка входных токенов (символы / 3,6)", summary: prompt.estimatedTokens },
        ]} />
        <p className="perf-note">Размер первичного запроса генерации в кодовых единицах UTF-16; оценка токенов приблизительна. Повторные запросы, исправления и отдельная проверка сюда не входят. Секции измерены отдельно, могут пересекаться и не покрывают весь промпт; процент — медиана долей по ходам.</p>
        <ul className="perf-sections" aria-label="Медианная доля секции по ходам">{prompt.sections.map((section) => <li key={section.key}>
          <div><span>{section.label}</span><strong>{format(section.summary.p50, "count")} · {section.share}%</strong></div>
          <span className="perf-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, (section.share / maxShare) * 100)}%` }} /></span>
          <small>p95 {format(section.summary.p95, "count")} символов</small>
        </li>)}</ul>
      </> : <p className="perf-empty">Бюджет промпта записывается для новых ходов живого рассказчика; автономный движок промпт не строит.</p>}
      {report.turns.models.length > 0 && <p className="perf-note">Модели в выборке: {report.turns.models.map((model) => `${model.model} (${model.count})`).join(", ")}.</p>}
    </>}
  </section>;
}
