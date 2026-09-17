import { PROFILE_SPECS, RULES_PROFILE_IDS } from "@/lib/profiles";
import { LAYER_INFO, SOURCE_INFO } from "@/lib/memory-ui";

export const metadata = { title: "Blueprint — архитектура Chronicle Engine" };

const PIPELINE = [
  { n: "1", t: "Контекст", d: "Параллельно: последние ходы, top-60 нод памяти, инвентарь (#ref), квесты (key), NPC (key), объекты сцены, локации." },
  { n: "2", t: "Семантический поиск", d: "Запрос = действие + локация + последняя сцена → gemini-embedding-2 → cosine по нодам сессии → hybrid-rerank (similarity 0.55, importance 0.2, recency 0.1, salience 0.05, provenance 0.1) → до 8 нод, ≤4 на слой." },
  { n: "3", t: "Проверка по профилю", d: "d20: серверный бросок vs DC; rules-light: оценка риска + 2d6 (полный успех / успех с ценой / провал); narrative: без броска. Результат — факт в промпте, до вызова ИИ." },
  { n: "4", t: "Единый контракт", d: "Оба типа хода возвращают JSON: narration, outcome, choices, effects, stateChanges{location, quests, npcs, inventory, sceneObjects, conditions, flags}. responseSchema у провайдера + runtime-парсер на сервере." },
  { n: "5", t: "Reducers", d: "Чистые функции по профилю: клампы ресурсов, согласование outcome с броском, проверка владения предметом и количества, терминальные квесты, мёртвые NPC, лимиты новых сущностей, единый источник истины для локации." },
  { n: "6", t: "Транзакция", d: "pg_advisory_xact_lock(session) → player-ход (requestId, уникальный индекс) → сессия → narrator-ход (stateChanges, contextMeta) → операции по таблицам → канонические ноды памяти (source=state)." },
  { n: "7", t: "Фон (after)", d: "Semantic-extractor (fastTaskModel, schema, цитата-доказательство, идемпотентен по ходу) → outbox эмбеддингов → batchEmbedContents." },
];

export default function BlueprintPage() {
  return (
    <div className="space-y-6 pt-8">
      <div className="card p-6 md:p-8">
        <p className="text-xs uppercase tracking-[0.25em] text-amber-300">Архитектурный манифест</p>
        <h1 className="mt-1 text-3xl font-black text-white">Blueprint: как устроен Chronicle Engine v2</h1>
        <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-slate-300">
          Принцип: <b className="text-white">модель предлагает, сервер решает</b>. ИИ даёт художественную интерпретацию и структурированные изменения мира; сервер валидирует их по профилю механик, применяет в одной транзакции и только из подтверждённого состояния строит каноническую память. Свободные кампании — AI-first; офлайн-фолбэк остаётся исключительно у пресетов.
        </p>
      </div>

      <div className="card p-6">
        <h2 className="text-lg font-extrabold text-white">🔁 Конвейер хода</h2>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {PIPELINE.map((p) => (
            <div key={p.n} className="rounded-xl bg-white/5 p-3">
              <b className="text-amber-200">{p.n}. {p.t}</b>
              <p className="mt-1 text-[12.5px] text-slate-300">{p.d}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="card p-6">
          <h2 className="text-lg font-extrabold text-white">🎛 Профили механик</h2>
          <div className="mt-3 space-y-2">
            {RULES_PROFILE_IDS.map((id) => {
              const p = PROFILE_SPECS[id];
              return (
                <div key={id} className="rounded-xl bg-white/5 p-3 text-[12.5px]">
                  <b className="text-white">{p.label}</b>
                  <p className="text-slate-300">{p.description}</p>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">
                    проверка: {p.check} · лимиты/ход: hp ±{p.limits.hp}, xp ≤{p.limits.xp}, средства ±{p.limits.gold}, отношение ±{p.limits.relation}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
        <div className="card p-6">
          <h2 className="text-lg font-extrabold text-white">🧠 Memory House: слои и происхождение</h2>
          <div className="mt-3 grid gap-1.5 text-[12.5px]">
            {Object.entries(LAYER_INFO).map(([k, v]) => (
              <div key={k} className="flex justify-between rounded-lg bg-white/5 px-3 py-1.5"><span className="text-slate-100">{v.icon} {v.label}</span><span className="text-slate-500">{v.hint}</span></div>
            ))}
          </div>
          <p className="mt-3 text-xs uppercase tracking-widest text-slate-400">Источники (provenance)</p>
          <div className="mt-1 grid gap-1.5 text-[12.5px]">
            {Object.entries(SOURCE_INFO).map(([k, v]) => (
              <div key={k} className="flex justify-between rounded-lg bg-white/5 px-3 py-1.5"><span className="text-slate-100">{v.icon} {v.label}</span><span className="text-slate-500">{v.hint}</span></div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-slate-400">Дедупликация: upsert по entityKey (npc:key, quest:key, item:slug, location:slug) для эволюционирующих фактов; append по contentHash для событий. Compaction сжимает, но не меняет игровое состояние.</p>
        </div>
      </div>

      <div className="card p-6">
        <h2 className="text-lg font-extrabold text-white">🧭 Эмбеддинги без pgvector — и с ним</h2>
        <p className="mt-2 text-[13px] text-slate-300">
          Векторы хранятся в <code>memory_embeddings.vector real[]</code> с моделью, размерностью, хешем контента и статусом outbox (pending → ready/failed, до 3 попыток). Поиск всегда ограничен sessionId, поэтому cosine на стороне приложения по сотням нод занимает миллисекунды и работает на любом PostgreSQL. Для больших инсталляций путь апгрейда: расширение <code>vector</code>, колонка <code>vector(768)</code>, HNSW-индекс и замена ранжирования на SQL-оператор <code>&lt;=&gt;</code> — интерфейс <code>searchMemory()</code> не меняется. Запросы форматируются по документации Embeddings 2: <code>task: search result | query: …</code> для запроса и <code>title: … | text: …</code> для документов.
        </p>
      </div>

      <div className="card p-6">
        <h2 className="text-lg font-extrabold text-white">🛡 Надёжность и наблюдаемость</h2>
        <ul className="mt-2 space-y-1.5 text-[13px] text-slate-300">
          <li>· Идемпотентность хода: requestId + уникальный индекс; повтор возвращает применённый результат.</li>
          <li>· Сериализация ходов одной кампании через advisory-lock — двойной клик и параллельные вкладки безопасны.</li>
          <li>· Дневные лимиты моделей соблюдаются сервером (лимит × ключи), пропуски видны в contextMeta.skippedModels.</li>
          <li>· Каждый narrator-ход хранит применённые stateChanges и retrievedIds — можно объяснить любое изменение мира.</li>
          <li>· Миграции: versioned ledger (drizzle migrator) + идемпотентный SQL; безопасен апгрейд с v1.</li>
          <li>· Тесты: reducers, парсер контракта, кости, лимиты, фильтр экстрактора — <code>npm test</code>.</li>
        </ul>
      </div>
    </div>
  );
}
