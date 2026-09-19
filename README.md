# Chronicle Engine · 2.5

Интерактивные истории любого жанра: восемь авторских миров, собственные кампании, три профиля правил, память на **gemini-embedding-2**, независимые сюжетные ветки и интерфейс на собственной дизайн-системе.

## Что нового в v2.5

В этой версии объединены совместимые улучшения двух независимых ревизий проекта.

**Надёжность.** Запрос хода регистрируется до обращения к AI, имеет lease и
сохранённый результат для безопасного повтора. Появились durable-задания памяти,
worker, диагностика `/system`, согласованная компакция и immutable-контрольные
точки, из которых можно создавать независимые ветки кампании.

**Интерфейс.** Старый стилевой слой заменён системой токенов: обычный текст не
мельче 12 px, поверхности визуально разделены, цвета рассчитаны на AA-контраст,
а анимации уважают `prefers-reduced-motion`. Настройки чтения позволяют менять
размер прозы, ширину строки, палитру и движение.

**Карта и управление.** В игровую панель встроена интерактивная миникарта с
маршрутами, опасностью, текущей точкой и крупным режимом. Неоткрытые места не
попадают в карту. `1–9` выбирают вариант, `/` фокусирует действие,
`←/→/Home/End` переключают панели; добавлены skip-link, `aria-live` и подсказки
первого хода.

**Совместимость.** Готовые пресеты по-прежнему работают без Gemini через
детерминированный автономный движок. Свободные кампании остаются AI-first и без
ключа возвращают `AI_REQUIRED`. Текущие WebP-обложки сохранены. Миграция `0003`
только добавляет настройки чтения и не удаляет старые колонки или данные.

Архитектурные решения интеграции: [revision integration design](docs/superpowers/specs/2026-09-19-revision-integration-design.md).

## Запуск

Требуются Node.js 20.9+ и PostgreSQL. Next.js 16.3.5, React 19, Drizzle ORM, node-postgres, Tailwind CSS 4.

1. `npm install`.
2. Создать `.env` по `.env.example`, настроить `DATABASE_URL`.
3. `node --env-file=.env --import tsx scripts/migrate.ts`.
4. `npm run dev`.

Миграции — явный deploy step, четыре версии в Drizzle ledger. Повторный запуск безопасен. В одноразовой песочнице допустим `npx drizzle-kit push`; для production используйте версионированные миграции.

Ключ Gemini можно добавить в **Настройках** или через серверные `GEMINI_API_KEYS` / `GEMINI_API_KEY`. Пресеты доступны без ключа. Для свободной истории включите живого мастера.

### Постоянный worker

На том же сервере/в отдельном процессе с тем же DATABASE_URL и ключами:

`node --env-file=.env --import tsx scripts/memory-worker.ts`

Один ограниченный проход: добавить `--once`. Постоянный процесс следует запускать через systemd/supervisor/контейнерный оркестратор, а не из HTTP-handler. Он обрабатывает одно извлечение и до 32 векторов за tick, затем делает паузу. SIGTERM/SIGINT завершают его после текущего ограниченного задания. Состояние видно на `/system`.

В проверочной среде запускался `--once`; постоянно работающий процесс не оставлялся.

## Страницы

| Страница | Назначение |
|---|---|
| `/` | Обзор и продолжение историй |
| `/campaigns` | Кампании, ветки, архив, переименование и удаление |
| `/worlds` | Миры, жанры, профили, поиск и избранное |
| `/characters` | Герои и профильные характеристики |
| `/play/:id` | Игра, запрос хода, развилки, состояние мира |
| `/memory` | Факты с provenance, текстовый/семантический поиск, reindex |
| `/journal` | Журнал и полный Markdown export |
| `/system` | Очереди, heartbeat, обработка и повтор failed-заданий |
| `/settings` | Ключи, routing, лимиты, embeddings и тест подключения |
| `/blueprint` | Устройство движка, реализованное и открытые задачи |

## API v2.2

Существующие API сохранены. Дополнительно:

- `POST /api/sessions/:id/act`: `{action, custom, requestId?, expectedTurn?}`. `custom:false` допускает только вариант текущей сцены.
- `GET /api/sessions/:id/requests/:requestId`: этап, статус и сохранённый результат.
- `GET/POST /api/sessions/:id/checkpoints`: список / `{title, requestId?, expectedTurn?}`.
- `DELETE /api/sessions/:id/checkpoints/:checkpointId`: удалить только точку.
- `POST /api/sessions/:id/checkpoints/:checkpointId/fork`: `{title, requestId?}` → новая кампания.
- `GET /api/system/status`: реальные счётчики и heartbeat без ключей и полных промптов.
- `POST /api/system/process`: `{action:"process"}` для ограниченного прохода либо `{action:"retry"}` для возвращения failed-заданий в очередь.

Остаются PATCH/DELETE кампании, экспорт Markdown, older-turn pagination, настройки, статистика токенов и healthcheck.

## Embeddings

Только стабильная **gemini-embedding-2**, по умолчанию 768 измерений. Task задаётся текстовым префиксом, **не** taskType. Preview/001 не являются fallback. Проверяются модель, размерность, finite/nonzero значения, обе sessionId и актуальность content hash. Query-vector cache: максимум 128 записей и 2 минуты.

Векторы пока в `real[]`, cosine на сервере внутри кампании. Это не pgvector/ANN. Качество реального поиска и генерации без API-ключа не измерялось: mock-provider проверяет контракт и гонки, не recall/литературное качество.

## Проверки

- Unit/контрактные тесты: `npm test`.
- Базовая интеграция: `node --env-file=.env --import tsx scripts/smoke.ts`.
- v2.2 (ветки, admission, single provider call, leases, semantic jobs, компакция): `node --env-file=.env --import tsx scripts/v22-smoke.ts`.
- Чистая БД и повтор миграций: `node --env-file=.env --import tsx scripts/migrations-check.ts` (требует CREATE DATABASE).
- Браузер: `npx playwright install --with-deps chromium`, затем `node --env-file=.env --import tsx scripts/browser-smoke.ts` и `node --env-file=.env --import tsx scripts/v22-browser.ts`.
- Аудит читаемости и контраста во всех палитрах: `npm run audit:ui` (сервер должен работать).
- Быстрые команды: `npm run verify` (typecheck + тесты + сборка), `npm run migrate`, `npm run worker`, `npm run smoke`, `npm run smoke:v22`.
- Базовый browser smoke ожидает одну стартовую кампанию. v2.2 browser smoke создаёт свои данные, проверяет потерянный после commit ответ и reload; снимки в `artifacts/`.
- Typegen: `npx next typegen`; TS: `npm exec tsc -- --noEmit --pretty false`; production: `npm run build`.
- `npm audit --omit=dev`: 0 advisories на момент проверки, не полноценный security audit.

Интеграционные скрипты требуют работающего тестового сервера (`SMOKE_BASE_URL`, по умолчанию localhost:3000). Используйте изолированную offline-среду без Gemini-ключей. Созданные тестовые кампании удаляются.

## Честные границы и следующие этапы

Приложение рассчитано на приватное пространство одного владельца. **Нет авторизации и tenant isolation; сохранённые в БД ключи ещё не зашифрованы.** Не публикуйте его как multi-user сервис без этих мер. Лимиты провайдера пока не резервируются атомарно по Google-проекту. Lease защищает запись состояния, но при аварии процесса не обещает exactly-once внешней оплаты AI.

Следующие приоритеты: auth/ownership + envelope encryption; проектный бюджет и admission quota; индекс/очереди под измеренной нагрузкой; pgvector после benchmark; recall@K/genre drift/entailment evaluation; затем authored scene graphs, streaming и мультимодальная память. Произвольное branch-from-turn потребует event log и replay: текущие контрольные точки этого не имитируют.

[Отчёт и план v2.2](docs/superpowers/plans/v2.2-reliability-and-branches.md) · [Дизайн-система v2.4](docs/superpowers/plans/v2.4-design-system-and-roadmap.md) · [Roadmap](docs/superpowers/plans/roadmap.md).
