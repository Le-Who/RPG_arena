"use client";
import { useCallback, useEffect, useState } from "react";
import { Camera, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { api } from "@/lib/api-client";
import type { ImageModelChoice } from "@/lib/visual-models";

type ModelSettings = { model: string; keyConfigured: boolean; models: ImageModelChoice[]; catalogError: string | null };

export function VisualModelSettings() {
  const [data, setData] = useState<ModelSettings | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api<ModelSettings>("/api/system/visual-model");
      setData(result); setSelected(result.model);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось загрузить настройки модели."); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const save = async () => {
    setBusy(true); setError(""); setSaved("");
    try {
      const result = await api<{ model: string }>("/api/system/visual-model", { method: "PATCH", body: JSON.stringify({ model: selected }) });
      setData(old => old ? { ...old, model: result.model } : old);
      setSaved("Модель сохранена для новых иллюстраций.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить модель."); }
    finally { setBusy(false); }
  };
  return <div className="system-page">
    <div className="page-heading"><div><div className="eyebrow">НАСТРОЙКИ АДМИНИСТРАТОРА</div><h1>Модель иллюстраций</h1><p>Выбор действует на новые иллюстрации всех кампаний. Уже созданные записи сохраняют свою модель и seed.</p></div></div>
    <section className="system-card">
      <div className="system-card-heading"><div><Camera size={20} /><h2>Pollinations</h2></div><button className="button secondary" type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={14} />Обновить каталог</button></div>
      {!data && !error && <p role="status"><LoaderCircle size={14} className="spin" /> Загружаем каталог моделей…</p>}
      {data && <>
        <p>Текущая модель: <strong>{data.model}</strong>.</p>
        {!data.keyConfigured && <p className="notice">Генерация сейчас недоступна: серверный <code>POLLINATIONS_API_KEY</code> не настроен. Выбранная модель сохранится до подключения ключа.</p>}
        {data.catalogError && <p className="notice amber" role="status">{data.catalogError}</p>}
        <label className="field"><span>Модель для новых изображений</span><select value={selected} disabled={busy || !data.models.length} onChange={event => { setSelected(event.target.value); setSaved(""); }}>
          {!data.models.some(model => model.id === selected) && <option value={selected}>{selected} (нет в текущем каталоге)</option>}
          {data.models.map(model => <option key={model.id} value={model.id}>{model.title} · {model.id}{model.paidOnly ? " · платная" : ""}</option>)}
        </select></label>
        <p className="system-footnote">Каталог показывает официальные модели Pollinations для генерации изображения по тексту. Цена, доступность и ограничения размеров зависят от модели и аккаунта. При ошибке генерации сохранённая модель не заменяется другой автоматически.</p>
        <div className="system-card-actions"><button className="button primary" type="button" disabled={busy || selected === data.model || !data.models.some(model => model.id === selected)} onClick={() => void save()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}Сохранить модель</button></div>
      </>}
      {error && <p className="notice error-notice" role="alert">{error}</p>}
      {saved && <p className="notice" role="status">{saved}</p>}
    </section>
  </div>;
}
