"use client";
import { useMemo, useState } from "react";
import { formatModelPrice, formatPriceRate, comparableModelPrice, shortlistModels, type ModelPrice } from "@/lib/model-pricing";
import { ContextualHelp } from "./contextual-help";

export type ModelChoiceEntry = { id: string; name: string; price?: ModelPrice; endpoint?: string; generationSupported?: boolean; community?: boolean };
export function ModelChoice({ models, selected, onChange, label, disabled = false }: { models: ModelChoiceEntry[]; selected: string; onChange: (model: ModelChoiceEntry) => void; label: string; disabled?: boolean }) {
  const [all, setAll] = useState(false), [query, setQuery] = useState("");
  const sorted = useMemo(() => [...models].sort((a, b) => {
    if (Boolean(a.community) !== Boolean(b.community)) return Number(Boolean(a.community)) - Number(Boolean(b.community));
    const x = comparableModelPrice(a.price), y = comparableModelPrice(b.price);
    if (x && y && x.currency === y.currency && x.unit === y.unit && x.basis === y.basis) return x.amount - y.amount;
    return Number(Boolean(y)) - Number(Boolean(x));
  }), [models]);
  const filtered = all ? sorted.filter(model => `${model.name} ${model.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : shortlistModels(sorted.filter(model => (!model.community && model.generationSupported !== false) || model.id === selected), selected, selected && !models.some(model => model.id === selected) ? 2 : 3);
  const chosen = models.find(model => model.id === selected);
  return <div className="model-choice">
    <div className="model-choice-heading"><span>{label}</span><ContextualHelp title="Модели и стоимость"><p>Короткий список содержит несколько подходящих вариантов. Остальные доступны через поиск. Выбранная модель остаётся в коротком списке.</p><p>Сравниваются цены с одинаковыми единицами и условиями. Фиксированная цена картинки, ставка за мегапиксель и оплата за токены — разные способы расчёта. Отсутствующая цена не означает бесплатную генерацию.</p><p>Для текста показан пример одного запроса: 8 000 входных и 1 000 выходных токенов без кэша и инструментов. Один игровой ход может включать несколько запросов.</p><p>В создании с нуля доступны модели, которым не требуется исходное изображение. Модель с необязательным референсом может оставаться доступной.</p>{chosen?.price && <><h3>Цена выбранной модели</h3><p>{formatModelPrice(chosen.price)}</p><ul>{chosen.price.rates.map((rate,index)=><li key={index}>{formatPriceRate(rate,chosen.price!.currency)}</li>)}</ul>{chosen.price.variants?.map(variant=><div key={variant.id}><h3>{variant.label}</h3>{variant.rates.map((rate,index)=><p key={index}>{formatPriceRate(rate,chosen.price!.currency)}</p>)}</div>)}{chosen.price.conditions.map((condition, index) => <p key={index}>{condition}</p>)}<p>Проверено: {new Date(chosen.price.checkedAt).toLocaleString("ru")}{chosen.price.stale ? " · сохранённые данные" : ""}.</p><a href={chosen.price.source} target="_blank" rel="noreferrer">Источник тарифа</a></>}<p>Тарифы могут измениться. Цена не является денежным лимитом. Бесплатная квота Gemini зависит от вашего проекта.</p></ContextualHelp></div>
    {all && <label className="field"><span className="sr-only">Найти модель {label === "Модель рассказчика" ? "рассказчика" : "иллюстраций"}</span><input type="search" aria-label={`Найти модель ${label === "Модель рассказчика" ? "рассказчика" : "иллюстраций"}`} value={query} placeholder="Название модели" onChange={event => setQuery(event.target.value)} /></label>}
    <fieldset className="model-choice-list" disabled={disabled}><legend className="sr-only">{label}</legend>
      {selected && !models.some(model => model.id === selected) && <div className="model-choice-current"><strong>{selected}</strong><span>Ваш выбор · цена пока неизвестна</span></div>}
      {filtered.map(model => <label key={model.id} className={`model-choice-row ${selected === model.id ? "selected" : ""}`}><input type="radio" name={label} value={model.id} checked={selected === model.id} onChange={() => onChange(model)} /><span><strong>{model.name}</strong><span className="model-choice-price">{formatModelPrice(model.price)}</span>{model.community && <small>Модель сообщества</small>}{model.generationSupported === false && <small>Создание без исходной картинки ещё не подтверждено</small>}</span></label>)}
    </fieldset>
    {!filtered.length && <p className="settings-footnote">{query ? "Моделей с таким названием не найдено." : "Каталог пока не загружен."}</p>}
    <button type="button" className="text-button" aria-expanded={all} onClick={() => { setAll(value => !value); setQuery(""); }}>{all ? "Короткий список" : "Все модели и поиск"}</button>
  </div>;
}
