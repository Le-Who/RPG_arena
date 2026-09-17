# Chronicle Engine · 2.1

Интерактивные истории со свободой действия. Восемь авторских миров, собственные кампании, три профиля правил и память на **gemini-embedding-2**.

Рабочая версия на основе [Le-Who/RPG_arena](https://github.com/Le-Who/RPG_arena), main `14cd16661599350a89fe6f54396bf3442df08d63`. Исходный roadmap `a6f9a55` сохранён в документации. Изменения в оригинальный GitHub не отправлялись.

## Главное

**Модель предлагает — сервер решает.** Предметы, цели, отношения, локации и память сохраняются через Drizzle ORM в PostgreSQL. Параллельный запоздавший ход не перезаписывает мир; повтор requestId возвращает тот же результат.

- `preset`: авторская история, допускает упрощённый автономный режим.
- `free`: собственный мир, AI-first; без доступного Gemini ход отклоняется с понятным `AI_REQUIRED`, без поддельного сюжета.
- `d20`: серверные броски, характеристики, ресурсы.
- `rules-light`: 2d6 и риск, минимальные ресурсы.
- `narrative`: без обязательных бросков и ресурсных панелей.

Новые миры: **Станция «Эхо»** и **Последний рейс**. Сохранены шесть исходных пресетов.

## Запуск

Требуются Node.js 20.9+ и PostgreSQL. Зависимости: Next.js 16.3.5, React 19, Drizzle ORM, node-postgres, Tailwind CSS 4.

1. Установить зависимости: `npm install`.
2. Создать `.env` по `.env.example`, настроить `DATABASE_URL`.
3. Применить версионированные миграции: `node --env-file=.env --import tsx scripts/migrate.ts`.
4. Запустить разработку: `npm run dev`.

Миграции — явный deploy step, не скрытый побочный эффект каждого запроса. Drizzle хранит ledger. Повторный запуск безопасен. В одноразовой песочнице можно использовать `npx drizzle-kit push`; не смешивайте этот путь с ручными production-изменениями без review.

Gemini не нужен для просмотра и запуска пресетов. Для AI добавьте ключ в **Настройках** и включите живого мастера. Альтернатива: `GEMINI_API_KEYS` (через запятую) или `GEMINI_API_KEY` в серверном окружении. Ключи не входят в клиентский bundle. Сохранённые в БД ключи сейчас **не зашифрованы**: приложение рассчитано на приватное пространство одного владельца, не на открытый multi-user production.

## Страницы

| Страница | Назначение |
|---|---|
| `/` | Обзор, продолжение историй, подборка миров |
| `/campaigns` | Переименование, архивирование, восстановление, удаление, экспорт |
| `/worlds` | Поиск, жанры, профили механик, избранное |
| `/characters` | Герои кампаний, навыки и профильные характеристики |
| `/play/:id` | Ходы, варианты, свободное действие, мир, вещи, цели, память |
| `/memory` | Факты с provenance, текстовый/семантический поиск, reindex |
| `/journal` | Последние записи и скачивание полного Markdown-журнала |
| `/settings` | Ключи, routing, лимиты, embeddings, тест подключения |
| `/blueprint` | Устройство движка, реализованные улучшения и открытые этапы |

## API

Существующие session/act/memory/compact/settings/tokens API сохранены. Дополнительно:

- `PATCH /api/sessions/:id` — title, status (active/archived/paused/finished).
- `GET /api/sessions/:id/export` — полный журнал Markdown.
- `GET /api/sessions/:id/turns?before=N` — предыдущие 60 записей.
- `GET/PATCH /api/workspace` — имя профиля и избранные миры.
- `POST /api/settings/test` — реальный проверочный вызов gemini-embedding-2.
- `GET /api/health` — проверка соединения с PostgreSQL.

## Надёжная память

Memory node и outbox создаются атомарно. Индексатор арендует задания на 45 секунд, работает вне DB-транзакции во время сети и применяет результат только при совпадении lease token + content hash. Есть backoff, failed status, reindex/backfill и восстановление истёкших leases.

Для поиска используется ровно `gemini-embedding-2`, по умолчанию 768 измерений. Task задаётся префиксом текста, **не** taskType. Preview/001 не являются fallback. Поиск проверяет обе sessionId, модель, размерность, статус и актуальность хеша. Query-vector cache ограничен 128 записями/двумя минутами.

Векторы пока хранятся в `real[]`, cosine вычисляется на сервере внутри кампании. Это не pgvector и не ANN. Постоянного worker пока нет: доставка запускается после запросов или через reindex. Качество реального семантического поиска не измерялось без API-ключа; тестовый mock проверяет контракт и транзакционные гарантии, не recall.

## Проверки

- Unit/контрактные тесты (52): `node --env-file=.env --import tsx --test tests/*.test.ts`.
- API + PostgreSQL + mock-provider smoke (сервер должен работать; Live AI выключен): `node --env-file=.env --import tsx scripts/smoke.ts`.
- Чистая БД и повтор миграций (нужны права CREATE DATABASE): `node --env-file=.env --import tsx scripts/migrations-check.ts`.
- Браузер: `npx playwright install --with-deps chromium`, затем `node --env-file=.env --import tsx scripts/browser-smoke.ts`. Скрипт ожидает хотя бы одну стартовую кампанию для проверки rename-dialog. Снимки — `artifacts/`.
- Typegen: `npx next typegen`.
- TypeScript: `npm exec tsc -- --noEmit --pretty false`.
- Production: `npm run build`.
- Проверка runtime dependencies: `npm audit --omit=dev` (0 advisories на момент этапа; это не полный аудит безопасности, у dev-инструментов есть advisories).

`SMOKE_BASE_URL` позволяет выбрать адрес уже работающего тестового сервера (по умолчанию localhost:3000). Smoke-скрипты создают временные кампании и удаляют их; не запускайте их с рабочими AI-ключами или в публичной production-среде.

## Документация и следующий этап

Полный анализ кода, архитектурные риски, технические альтернативы и приоритеты: [v2.1 audit and plan](docs/superpowers/plans/2026-09-17-v2.1-audit-and-plan.md).

[Roadmap](docs/superpowers/plans/roadmap.md) · [исходный roadmap](docs/superpowers/plans/roadmap-initial-a6f9a55.md).

Следующие приоритеты: auth/ownership + encryption; атомарное резервирование квот по Google-проекту; admission lease перед AI; постоянный worker; pgvector после измерений; evaluation recall@K/genre drift; затем streaming, scene graphs, мультимодальная память и ветвление историй. Эти пункты пока являются планом, не готовыми возможностями.
