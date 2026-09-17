# 📖 CHRONICLE ENGINE (RPG ARENA) — v2

Интерактивная новелла со свободой действия для **любого жанра**: нуар, космос, хоррор, бытовая драма, классическая героика. ИИ-мастер (Gemini) ведёт сцену, а **сервер валидирует и применяет каждое изменение мира** — предметы, локации, отношения, цели, состояния героя. Память кампании строится из подтверждённых фактов и находится **по смыслу** через `gemini-embedding-2`.

> Принцип v2: **модель предлагает — сервер решает.** Подробный разбор архитектуры и принятых решений: [`docs/superpowers/plans/2026-09-17-v2-architecture-upgrade.md`](docs/superpowers/plans/2026-09-17-v2-architecture-upgrade.md). Дорожная карта: [`docs/superpowers/plans/roadmap.md`](docs/superpowers/plans/roadmap.md).

---

## Что умеет

| Область | Реализация |
|---|---|
| **Режимы кампании** | `preset` — 6 авторских историй с офлайн-фолбэком; `free` — AI-first: без ключа Gemini ход честно отклоняется (`409 AI_REQUIRED`), а не подменяется шаблоном |
| **Профили механик** | `d20` (серверный бросок vs DC, статы, HP/XP/золото) · `rules-light` (оценка риска + 2d6: полный успех / успех с ценой / провал; без статов и уровней) · `narrative` (без бросков и счётчиков; только состояния и отношения) |
| **Контракт хода** | Оба типа хода (вариант 1/2/3 и свободное действие) возвращают JSON: `narration, outcome, choices, effects, stateChanges{location, quests, npcs, inventory, sceneObjects, conditions, flags}`; provider `responseSchema` + runtime-парсер на сервере |
| **Reducers** | Клампы по профилю, согласование исхода с серверной проверкой, проверка владения и количества предметов, терминальные квесты, мёртвые NPC, лимиты новых сущностей, единый источник истины для локации |
| **Транзакция** | Один ход — одна транзакция с advisory-lock; `requestId` даёт идемпотентность (повтор возвращает применённый результат) |
| **Память** | 5 слоёв + provenance (`seed / state / ai-semantic / compaction`), `entityKey`-upsert и хеш-дедуп; state-события пишутся reducers; AI-экстрактор фактов работает асинхронно и принимает только факты с цитатой из текста |
| **Эмбеддинги** | `gemini-embedding-2` (768 dims, MRL), outbox-индексация, backfill/reindex, hybrid-retrieval внутри сессии; работает без pgvector (`real[]` + cosine), путь апгрейда на pgvector описан в Blueprint |
| **Лимиты** | Дневные лимиты моделей соблюдаются сервером (лимит × число ключей); ключи из БД + `GEMINI_API_KEYS` |
| **Миграции** | drizzle migrator с ledger; идемпотентный SQL, безопасный апгрейд с v1 |

---

## Конвейер хода

```
Игрок (вариант 1/2/3 или свободный ввод, requestId)
   │
   ├─ параллельно: последние ходы · top-60 памяти · инвентарь(#ref) · квесты(key) · NPC(key) · объекты сцены · локации
   ├─ семантический поиск: embed(действие + сцена) → cosine по нодам сессии → hybrid-rerank → ≤8 нод
   ├─ проверка по профилю ДО вызова ИИ: d20 vs DC │ 2d6 риск │ нет
   ▼
Gemini (routing: Lite для вариантов, Flash для свободных действий) → JSON по схеме
   ▼
parseResolution (runtime-нормализация) → applyResolution (reducers по профилю)
   ▼
ТРАНЗАКЦИЯ: player-ход → сессия → narrator-ход (stateChanges, contextMeta) → таблицы → state-ноды памяти
   ▼
after(): semantic-extractor (fastTaskModel, с цитатами) → outbox эмбеддингов → batchEmbedContents
```

---

## Быстрый старт

```bash
git clone https://github.com/Le-Who/RPG_arena.git && cd RPG_arena
npm install
cp .env.example .env          # DATABASE_URL, опционально GEMINI_API_KEYS
npm run dev                   # миграции применяются при старте (drizzle migrator)
npm test                      # reducers, парсер контракта, кости, лимиты, экстрактор
```

Откройте `http://localhost:3000`, добавьте ключ Google AI Studio в **Настройках**, включите Live. Без ключа доступны только пресеты (офлайн-движок, помеченный в тексте хода).

Переменные окружения: `DATABASE_URL` (обязательно), `GEMINI_API_KEYS` (опционально, через запятую), `MIGRATIONS_STRICT=1` (падать при ошибке миграций).

---

## Страницы

- **`/`** — лобби: пресеты с указанием механики; конструктор свободной истории (мир, эпоха, тон, фракции, стартовая точка; герой, навыки, черты, предметы; статы для d20).
- **`/play/[id]`** — игровая комната: лог с чипами «что изменилось» (в т.ч. что отклонил сервер), варианты/свободный ввод, панели Герой (профильно-зависимые), Цели (квесты + NPC с отношением), Мир (карта + объекты сцены), Память (provenance, семантический поиск, переиндексация).
- **`/settings`** — ключи (БД + окружение), профили роутинга, матрица задач, эмбеддинги (модель/размерность), экстрактор фактов, лимиты с реальными счётчиками.
- **`/blueprint`** — архитектурный манифест.

---

## REST API

| Метод | Эндпоинт | Назначение |
|---|---|---|
| GET/POST | `/api/sessions` | Список / создание (`mode: preset\|free`, `rulesProfile`, `customScenario`, `customCharacter`) |
| GET/DELETE | `/api/sessions/:id` | Снимок: сессия, профиль, ходы, память, инвентарь, локации, квесты, NPC, объекты сцены, статус эмбеддингов |
| POST | `/api/sessions/:id/act` | Ход: `{ action, custom, requestId? }` → `{ narration, choices, dice, outcome, applied, retrieved, warnings, needsCompaction }`; `409 AI_REQUIRED` для free без ИИ, `503 AI_FAILED` при недоступности |
| POST | `/api/sessions/:id/compact` | Компакция памяти (source=compaction) + индексация |
| GET | `/api/sessions/:id/memories` | Статистика по слоям, источникам, эмбеддингам |
| GET | `/api/sessions/:id/memory/search?q=` | Семантический поиск с объяснением (`why`, `sourceTurn`) |
| POST | `/api/sessions/:id/memory/reindex` | Backfill + индексация pending |
| GET/POST | `/api/settings` | Настройки ИИ, лимитов, эмбеддингов |
| GET | `/api/tokens/stats` | Расход за сутки, лимиты, последние вызовы |
| GET | `/api/health` | Состояние БД и миграций |

---

## Структура

```
drizzle/0000_chronicle_engine_v2.sql   идемпотентная схема (ledger: __drizzle_migrations)
instrumentation.ts                     запуск миграций при старте
src/db/schema.ts                       сессии, ходы, память(+provenance), эмбеддинги, инвентарь, локации, квесты, NPC, объекты сцены, настройки, логи
src/lib/profiles.ts                    профили механик (ресурсы, лимиты, проверка, канон промпта)
src/lib/resolution.ts                  контракт, runtime-парсер, reducers, события памяти
src/lib/turn.ts                        оркестратор хода: контекст → проверка → AI/offline → транзакция → фон
src/lib/gemini.ts                      каталог моделей, роутинг, промпты, экстрактор, ротация ключей, лимиты
src/lib/embeddings.ts                  gemini-embedding-2: embed/batch, outbox, backfill, hybrid search
src/lib/memory.ts                      provenance-upsert, state-события, нормализация фактов экстрактора
src/lib/engine.ts                      офлайн-движок (только пресеты) + serverCheck по профилю
src/lib/scenarios.ts                   6 пресетов с rulesProfile, стартовым инвентарём и лут-пулом
tests/resolution.test.ts               unit-тесты (node --test + tsx)
```

---

## Ограничения и честные оговорки

- Ключи Gemini хранятся в БД открытым текстом (как в v1) — для production нужно шифрование at-rest.
- Квоты 20/500 — ориентиры бесплатного тарифа на ключ; фактические лимиты определяет Gemini. Сервер лишь не превышает настроенные значения.
- Эмбеддинги ищутся перебором внутри сессии — достаточно для сотен нод; для тысяч — pgvector.
- Лицензия проекта пока не опубликована (LEGAL-1).
