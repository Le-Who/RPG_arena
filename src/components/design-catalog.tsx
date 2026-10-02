"use client";
import { useCallback, useEffect, useState } from "react";
import { Activity, CheckCircle2, Palette, RefreshCw, TriangleAlert } from "lucide-react";
import { contrastRatio, gradeContrast, parseColor, type Rgb } from "@/lib/contrast";
import { summarizeApiTimings, type ApiRouteSummary } from "@/lib/perf-metrics";

/* DS-2: живой каталог токенов, контраст по палитрам и состояния компонентов.
   PERF-4: метрики текущей вкладки. Ничего не отправляется на сервер. */

const TOKEN_GROUPS: { title: string; kind: "color" | "size" | "other"; tokens: string[] }[] = [
  { title: "Поверхности", kind: "color", tokens: ["--bg", "--sunken", "--surface", "--raised", "--hover", "--overlay"] },
  { title: "Линии", kind: "color", tokens: ["--line", "--line-2", "--line-3"] },
  { title: "Текст", kind: "color", tokens: ["--ink", "--ink-2", "--ink-3", "--ink-4"] },
  { title: "Акцент и статусы", kind: "color", tokens: ["--accent", "--accent-2", "--accent-ink", "--accent-soft", "--accent-line", "--on-accent", "--ok", "--warn", "--bad", "--info"] },
  { title: "Типографика", kind: "size", tokens: ["--t-2xs", "--t-xs", "--t-sm", "--t-md", "--t-lg", "--t-xl", "--t-2xl", "--t-3xl", "--t-4xl"] },
  { title: "Ритм, радиусы, движение", kind: "other", tokens: ["--sp-1", "--r-xs", "--measure", "--ease", "--spring", "--out", "--d1", "--font"] },
];
const THEMES = [{ id: "midnight", label: "Полночь" }, { id: "sepia", label: "Сепия" }, { id: "contrast", label: "Контраст" }] as const;
const FOREGROUNDS = ["--ink", "--ink-2", "--ink-3", "--ink-4", "--accent-ink", "--ok", "--warn", "--bad"];
const BACKGROUNDS = ["--bg", "--surface", "--raised"];
type Matrix = Record<string, Record<string, number | null>>;

/** Resolve any CSS colour (oklch, color-mix, var) to sRGB by painting one canvas pixel. */
function resolveColor(token: string, probe: HTMLElement, ctx: CanvasRenderingContext2D): Rgb | null {
  probe.style.color = `var(${token})`;
  const computed = getComputedStyle(probe).color;
  const parsed = parseColor(computed);
  if (parsed) return parsed;
  ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = computed; ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}

function measureThemes(): Record<string, Matrix> {
  const html = document.documentElement;
  const original = html.getAttribute("data-theme");
  const probe = document.createElement("span"); probe.style.display = "none"; document.body.appendChild(probe);
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const result: Record<string, Matrix> = {};
  try {
    for (const theme of THEMES) {
      html.setAttribute("data-theme", theme.id);
      const matrix: Matrix = {};
      for (const fg of FOREGROUNDS) {
        matrix[fg] = {};
        for (const bg of BACKGROUNDS) {
          const f = ctx ? resolveColor(fg, probe, ctx) : null; const b = ctx ? resolveColor(bg, probe, ctx) : null;
          matrix[fg][bg] = f && b ? contrastRatio(f, { ...b, a: 1 }) : null;
        }
      }
      result[theme.id] = matrix;
    }
  } finally {
    if (original === null) html.removeAttribute("data-theme"); else html.setAttribute("data-theme", original);
    probe.remove();
  }
  return result;
}

export function DesignCatalog() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [matrices, setMatrices] = useState<Record<string, Matrix> | null>(null);
  const [api, setApi] = useState<ApiRouteSummary[]>([]);
  const refresh = useCallback(() => {
    const styles = getComputedStyle(document.documentElement);
    setValues(Object.fromEntries(TOKEN_GROUPS.flatMap(group => group.tokens).map(token => [token, styles.getPropertyValue(token).trim()])));
    setMatrices(measureThemes());
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    setApi(summarizeApiTimings(entries.map(e => ({ name: e.name, duration: e.duration, serverTiming: e.serverTiming, transferSize: e.transferSize })), location.origin));
  }, []);
  useEffect(() => { const frame = requestAnimationFrame(refresh); return () => cancelAnimationFrame(frame); }, [refresh]);
  const failures = matrices ? Object.entries(matrices).flatMap(([theme, m]) => Object.entries(m).flatMap(([fg, row]) => Object.entries(row).filter(([, r]) => r !== null && r < 4.5).map(([bg, r]) => `${theme}: ${fg} на ${bg} — ${r?.toFixed(2)}:1`))) : [];

  return <div className="x3-page">
    <div className="page-heading"><div className="eyebrow">DS-2 · PERF-4</div><h1>Дизайн-система</h1><p>Живые значения токенов текущей палитры, контраст по всем палитрам и состояния компонентов. Метрики относятся только к этой вкладке браузера и никуда не отправляются.</p></div>
    <div className="x3-toolbar"><button type="button" className="button secondary" onClick={refresh}><RefreshCw size={16} /> Пересчитать</button></div>

    <section className="x3-section" aria-labelledby="ds-tokens"><h2 id="ds-tokens"><Palette size={18} /> Токены</h2>
      {TOKEN_GROUPS.map(group => <div key={group.title} className="x3-group"><h3>{group.title}</h3><ul className={`x3-tokens ${group.kind}`}>{group.tokens.map(token => <li key={token}>
        {group.kind === "color" && <span className="x3-swatch" style={{ background: `var(${token})` }} aria-hidden />}
        {group.kind === "size" && <span className="x3-type" style={{ fontSize: `var(${token})` }} aria-hidden>Аа</span>}
        <code>{token}</code><small>{values[token] || "—"}</small></li>)}</ul></div>)}
    </section>

    <section className="x3-section" aria-labelledby="ds-contrast"><h2 id="ds-contrast"><CheckCircle2 size={18} /> Контраст WCAG по палитрам</h2>
      <p className="x3-note">Для обычного текста требуется 4.5:1; 3:1 относится только к крупному тексту (от 24px или от 18.67px полужирным). Измерение пар цветов не заменяет аудит всех состояний интерфейса.</p>
      {failures.length > 0 ? <div className="notice" role="alert"><TriangleAlert size={18} /><p><strong>Ниже нормы:</strong> {failures.join("; ")}</p></div> : matrices && <p className="x3-status ok" role="status"><CheckCircle2 size={16} /> Измеренные пары проходят 4.5:1.</p>}
      <div className="x3-matrices">{THEMES.map(theme => <table key={theme.id} className="x3-table"><caption>{theme.label}</caption><thead><tr><th scope="col">Текст \ фон</th>{BACKGROUNDS.map(bg => <th key={bg} scope="col"><code>{bg}</code></th>)}</tr></thead>
        <tbody>{FOREGROUNDS.map(fg => <tr key={fg}><th scope="row"><code>{fg}</code></th>{BACKGROUNDS.map(bg => { const r = matrices?.[theme.id]?.[fg]?.[bg] ?? null; return <td key={bg} data-grade={r === null ? "unknown" : gradeContrast(r)}>{r === null ? "…" : `${r.toFixed(2)}:1`}<small>{r === null ? "" : gradeContrast(r)}</small></td>; })}</tr>)}</tbody></table>)}</div>
    </section>

    <section className="x3-section" aria-labelledby="ds-states"><h2 id="ds-states">Состояния компонентов</h2>
      <div className="x3-states">
        <div><h3>Кнопки</h3><div className="x3-row"><button type="button" className="button primary">Основная</button><button type="button" className="button secondary">Вторичная</button><button type="button" className="text-button">Текстовая</button><button type="button" className="button primary" disabled>Недоступна</button><button type="button" className="button secondary" aria-busy="true" disabled>Сохраняем…</button></div></div>
        <div><h3>Фокус и клавиши</h3><div className="x3-row"><button type="button" className="button secondary x3-focus-demo">Видимый фокус</button><span><kbd>Ctrl</kbd> + <kbd>K</kbd> палитра</span></div></div>
        <div><h3>Уведомление</h3><div className="notice"><Activity size={18} /><p><strong>Пример.</strong> Текст уведомления использует <a href="#ds-states">ссылку</a> и вторичный цвет.</p></div></div>
      </div>
    </section>

    <section className="x3-section" aria-labelledby="ds-perf"><h2 id="ds-perf"><Activity size={18} /> Время API в этой вкладке</h2>
      <p className="x3-note">API — запросы с момента открытия вкладки. Это диагностическая выборка, а не полевые Web Vitals. «Сервер» — заголовок Server-Timing (время обработчика до начала ответа).</p>
      {api.length ? <table className="x3-table wide"><thead><tr><th scope="col">Маршрут</th><th scope="col">Запросов</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">Сервер p50/p95</th><th scope="col">Передано</th></tr></thead>
        <tbody>{api.map(row => <tr key={row.route}><th scope="row"><code>{row.route}</code></th><td>{row.count}</td><td>{row.p50} мс</td><td>{row.p95} мс</td><td>{row.serverP50 === null ? "—" : `${row.serverP50} / ${row.serverP95} мс`}</td><td>{Math.round(row.bytes / 1024)} КБ</td></tr>)}</tbody></table>
        : <p className="x3-note">API-запросов в этой вкладке пока нет. Откройте кампанию и вернитесь через палитру команд, чтобы увидеть распределение.</p>}
    </section>
  </div>;
}
