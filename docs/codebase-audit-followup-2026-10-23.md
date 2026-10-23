# Дополнительный аудит кодовой базы · 23 октября 2026

Проверен рабочий код Chronicle Engine от `c13faf8` после [предыдущего аудита](codebase-audit-2026-10-23.md). Три независимых субагента `gpt-6.1-sol` проверили доменное состояние, доступ и persistence с reasoning `high`, клиентские сценарии с `medium`. Координатор проверил провайдеры, квоты, фоновые задания, кэши, инструменты, зависимости и интеграцию. Итоговый diff дополнительно проверен независимым ревьюером `gpt-6.1-sol` с reasoning `xhigh`; подтверждённых открытых P1/P2 после исправлений и повторного review не осталось.

Сохранены `preset`/`free`, профили `d20`/`rules-light`/`narrative`, необязательность боёв и бросков и русский интерфейс. Схема SQL, исторические миграции и lockfile не менялись. Изменения ограничены воспроизведёнными дефектами; замена зависимостей или перестройка модулей без доказанной проблемы не выполнялись.

## Исправления

Каждый новый дефект поведения сначала воспроизведён падающей проверкой, затем исправлен с положительными контролями существующих сценариев.

| Область | Дефект и исправление | Регрессионное подтверждение |
|---|---|---|
| Инвентарь | Неизвестный или отсутствующий `inventory.op` превращался в `add` и мог выдать вещь вместо списания. Невалидная операция теперь отклоняется с диагностикой, остальные валидные операции сохраняются. | `resolution.test.ts` |
| Память предметов | Добавление по точному ref меняло существующий предмет, но semantic event брал предложенные моделью имя и описание. Память теперь использует канонические поля реально обновлённой вещи. | `resolution.test.ts` |
| Память NPC | Создание NPC сохраняло `dead`/`missing`/`unknown` в таблице, но теряло статус в semantic event. Принятый статус теперь отражается в памяти. | `resolution.test.ts` |
| События мира | Повторное предложение уже существующего события игнорировало `complete=true`. Наступившее событие с подтверждающей точной цитатой теперь становится `fired` без создания дубликата. | `world-agenda.test.ts` |
| Договорённости | Неизвестный явный ref создавал новую запись, неоднозначное имя выбирало первую. Обе ситуации теперь отклоняются, точная ссылка остаётся доступна. | `world-life.test.ts` |
| Статус договорённости | Обновление примечания без status сбрасывало `accepted` в `proposed`. Отсутствующий status теперь сохраняет текущий. | `world-life.test.ts` |
| Закрытие договорённости | Новая договорённость могла сразу появиться как `fulfilled`/`broken`/`cancelled`. Закрытие теперь требует существующей записи. | `world-life.test.ts` |
| Точные цитаты | Общий строковый parser сворачивал внутренние переводы строк и повторные пробелы evidence, после чего дословная проверка отклоняла правильную цитату. Agenda events, NPC goals, schedules и knowledge сохраняют внутренние пробелы в ограниченной по длине цитате. | `world-agenda.test.ts`, `world-social.test.ts` |
| Переносимый JSON | Разные UUID с одинаковым стабильным key у целей, NPC и объектов сцены проходили parser и нарушали SQL UNIQUE. Документ теперь получает HTTP 400 `INVALID_DOCUMENT` до записи. Проверка атомарного rollback сохранена с настоящим SQL trigger fault. | `campaign-portable.test.ts`, `campaign-portable-db.test.ts` |
| Запрос хода | Ответ после unmount вызывал старый `onCommitted` и очищал сохранённый request ID. Cleanup отменяет транспорт и инвалидирует callback; ID остаётся для восстановления и безопасного повтора при возвращении. | `turn-request-lifecycle-browser.ts` |
| Навигация после записи | Завершившиеся после ухода запросы копии, ветки checkpoint и создания истории выполняли старый `router.push`. Проверка жизненного цикла блокирует поздние переходы и сохраняет обычный успешный сценарий. | `turn-request-lifecycle-browser.ts` |
| Смена профиля при refresh | Независимое review воспроизвело окно между синхронным обнаружением нового профиля и React cleanup: mounted guard ещё разрешал переход. `refresh(expectedProfileId)` проверяет исходный профиль до HTTP и после bootstrap; copy/fork/create/import используют результат до навигации. Временный 503 и supersede тем же профилем сохраняют обычный успешный переход. Устаревший ответ 401 запрещает продолжение, сохраняя состояние более нового refresh. | `turn-request-lifecycle-browser.ts`, настоящий AppShell в `workspace-latency-browser.ts` |
| Создание до bootstrap | При создании истории или публичной копии с ещё неизвестной UI identity значение `undefined` теряло исходного владельца: поздний ответ кампании A мог вызвать переход уже из профиля B. Продолжение использует владельца сохранённого сервером результата и отдельно проверяет известный originating profile; неизвестный профиль требует подтверждения bootstrap. | `workspace-latency-browser.ts`: same/changed owner, POST до первоначального bootstrap, initial public copy |
| API client | Object spread терял заголовки из `Headers` и tuple arrays, разрешённых `RequestInit`. Заголовки нормализуются через `Headers`, явный Content-Type сохраняется. | `api-client.test.ts` |
| Ответы Jev | Общий транспорт и пилот памяти вызывали `response.json()` без ограничения размера. Единый транспорт теперь проверяет Content-Length и фактические байты, ограничивает ответ 200 000 байт и проверяет UTF-8. | `jev-transport-boundaries.test.ts`, `typesafe.test.ts` |
| Отмена Jev | Поздние headers после отмены и зависшее чтение оставляли тело ответа открытым. Тело теперь отменяется при внешней отмене и позднем ответе, reader освобождается. | `jev-transport-boundaries.test.ts` |
| HTTP-ошибки Jev | Ожидание зависшего `body.cancel()` подменяло HTTP 503 таймаутом. Отмена больше не блокирует результат; общий слой сохраняет `provider_error`, пилот — HTTP-код. | `jev-transport-boundaries.test.ts` |

## Охват и границы

Просмотрены серверные маршруты, auth/guest/account ownership и revocation, owner admission/fencing, secrets, strict portable parsing и remapping, copy/export/book/checkpoints, pool/schema/readiness/migrations и CI. В доменной части проверены turn admission, idempotency, lease и atomic commit, reducer immutability, resources/inventory/bindings, applied changes, location graph, life/agenda/social/commitments, conditions и narrative evidence/guard/generation/review/verifier/history. В клиентской части просмотрены AppShell/bootstrap/identity, PlayRoom/recovery, creator/import/copy/checkpoint, settings/provider формы, dialogs/focus/keyboard, записи истории, галерея, PWA/update и reading/workspace preferences.

Для провайдеров проверены Gemini и внешний text transport, каталоги и OAuth, visual transport, embeddings/query cache, quota admission, semantic jobs и worker lifecycle. Использованы локальные Next.js guides установленной версии. Контракты внешних API и версии пакетов не менялись.

Проверки используют Node 22.23.3 из `.node-version`. Обычный suite запускается через штатный `tests/helpers/test-environment.ts`, который задаёт недоступный рабочий DATABASE_URL и очищает credentials; SQL fixtures используют одноразовый PGlite. Browser lifecycle fixture собирает настоящие React-компоненты, подменяя только HTTP, Next navigation и AppShell context, и запускается на собственном loopback-сервере. Новая проверка включена в CI, её отчёт и снимки добавлены к browser artifacts.

## Верификация

Выполнены следующие проверки:

- Полный `npm test`: 1391/1391 passed, fail/cancelled/skipped/todo — 0; exit 0. После последних клиентских origin/401 исправлений повторно прошли семь затронутых ordinary test files — 22/22, финальные browser fixtures, typecheck, lint и build. Backend после полного прогона не менялся.
- `npm run typecheck` и `npm run lint`: exit 0 на итоговом дереве приложения.
- Production `next build`: exit 0 после всех исправлений review, включая stale 401 и создание до bootstrap. Использованы синтетический недоступный DATABASE_URL, отключённые auto-migrations и явно пустые provider credentials, перекрывающие `.env`.
- Целевые state/reducer suites: 196/196; четыре PGlite turn/location/narrative integration файла: 54/54.
- Portable parser и настоящий SQL rollback: 23/23. Начальные три проверки duplicate key воспроизвели дефект до исправления.
- Jev/TypeSafe/narrative verifier: 44/44; расширенные transport boundaries: 12/12, включая 199 999/200 000/200 001 байт, UTF-8 по одному байту и malformed UTF-8. Первоначальный transport regression run: 2 passed, 8 failed до исправления.
- API/client recovery/identity/committed-turn focused suite: 11/11.
- `turn-request-lifecycle-browser.ts`: 18/18 отчётных desktop/mobile lifecycle/identity checks; дополнительно проверены обычные успешные turn/copy/fork/create/import сценарии. StrictMode, keyboard send, сохранение и восстановление request ID включены.
- `workspace-latency-browser.ts`: 24/24 на настоящих AppShell, Overview, StoryCreator и CampaignCopyButton, включая origin fence, positive 503, concurrent same-profile supersede, stale 401 и создание/копирование до первоначального bootstrap.
- Существующий `owner-composer-p2-browser.ts`: 18/18 desktop/mobile checks.
- На итоговом изолированном production server: `client-state-browser.ts` 10/10 при 1440/390 px; `story-experience-browser.ts` прошёл полностью, включая settings retry, canonical guest repair, reading, settings overlay и dirty guard. После проверки сервер остановлен.
- `npm audit --json`: 0 известных уязвимостей, включая dev dependencies.
- `npm run check:docs`: 109 файлов, 469 локальных ссылок; актуальные npm-команды и ledger миграций проверены. Внешние URL и heading anchors checker не проверяет.
- Независимый финальный reviewer: 102/102 state/portable/API tests и 39/39 Jev/TypeSafe tests; самостоятельно повторены финальные AppShell 24/24 и lifecycle 18/18 browser проверки. Оба обнаруженных им P2 воспроизведены до исправлений и закрыты повторным review.
- `git diff --check`: exit 0.

Подробные логи хранятся в игнорируемом `output/`; lifecycle evidence — в `output/playwright/turn-request-lifecycle/report.json`, AppShell — в `output/playwright/workspace-latency/result.json`. CI проверен локально по коду и используемым командам; GitHub Actions на Linux в этой сессии не запускался.

Нативный PostgreSQL contention/process suite не выполнялся: Docker и psql в текущем PATH отсутствуют. Реальные кампании и платные provider evaluations не использовались. Результаты изолированных проверок не устанавливают качество живого рассказчика, production readiness или нагрузочные характеристики.
