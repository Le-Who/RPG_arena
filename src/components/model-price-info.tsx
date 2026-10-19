"use client";
import { formatModelPrice, formatPriceRate, type ModelPrice } from "@/lib/model-pricing";
export function ModelPriceInfo({ price }: { price?: ModelPrice }) {
  if (!price) return <p>Цена пока неизвестна. Откройте выбор модели, чтобы загрузить доступный тариф.</p>;
  return <><p>{formatModelPrice(price)}</p><ul>{price.rates.map((rate,index)=><li key={index}>{formatPriceRate(rate,price.currency)}</li>)}</ul>{price.conditions.map((condition,index)=><p key={index}>{condition}</p>)}{price.variants?.map(variant=><div key={variant.id}><h3>{variant.label}</h3>{variant.rates.map((rate,index)=><p key={index}>{formatPriceRate(rate,price.currency)}</p>)}</div>)}<p>Проверено: {new Date(price.checkedAt).toLocaleString("ru")}{price.stale ? ". Показан сохранённый тариф; текущая стоимость может отличаться." : "."}</p><a href={price.source} target="_blank" rel="noreferrer">Источник тарифа</a><p>Для текста пример одного запроса — 8 000 входных и 1 000 выходных токенов, без кэша и инструментов. Полный игровой ход может включать несколько запросов.</p><p>Цена не устанавливает денежный лимит. Бесплатная квота Gemini зависит от вашего проекта.</p></>;
}
