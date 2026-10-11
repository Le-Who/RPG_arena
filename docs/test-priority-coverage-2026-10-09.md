# Расширение покрытия P1 — 09.10.2026

По запросу владельца продолжен [аудит покрытия](test-coverage-audit-2026-10-09.md). Выбраны три воспроизводимые границы P1 из [матрицы](testing/coverage-matrix-2026-10-09.md): допуск и атомарность хода, права на уровне HTTP-обработчиков и изоляция изменений карты. Они защищают каноническое состояние и владение данными. [План и область](superpowers/plans/2026-10-09-priority-test-coverage.md) сохраняют остальные приоритеты и существующие task IDs.

Работа выполнена в managed worktree относительно `9aa2f55`. Исполнители использовали `gpt-6.1-sol`: reasoning `xhigh` для конкуренции ходов, `high` для HTTP authority и `medium` для карты; независимый reviewer — `xhigh`. Исторические миграции, их ledger и production-код приложения не изменены. Тестовые данные и ключи синтетические; сервер PostgreSQL принадлежит этому этапу.

## Допуск хода, fencing и атомарность

Новый [turn-postgres.integration.ts](../tests/integration/turn-postgres.integration.ts) вызывает настоящий `performTurn` с независимыми соединениями PostgreSQL и событийными барьерами на транспортной границе провайдера. Четыре subtests и родительская регистрация дают **5 runtime registrations**:

- Шесть одновременных вызовов одного requestId дают ровно один provider fetch, одну пару player/narrator, один completed request и один комплект durable jobs. Сохранённый результат проверяется по literal gameplay fields и сверяется с live response без observational timings; повтор возвращает его буквально без новой генерации.
- Первая попытка задерживается на ответе провайдера; её lease истекает, новая попытка получает другой токен. Освобождённая старая попытка получает `LEASE_EXPIRED` и не меняет новую строку запроса, историю или каноническое состояние.
- Lease истекает после стадии applying, когда commit ожидает advisory lock, удерживаемый отдельным соединением. Проверяется отказ внутри транзакции commit.
- SQL trigger отклоняет обновление completed request после временных записей состояния, двух turns, scene object, memory node и semantic/embedding outbox. Сравнение с независимым начальным снимком доказывает полный rollback всех этих записей.

Удаление token predicate отдельно приводит к принятию старой попытки, а перенос completion в отдельную транзакцию оставляет частично зафиксированные данные. Новые тесты отвергают обе временные мутации. После review дополнительная временная SQL-порча только completed narration отклонена независимыми оракулами обеих успешных попыток; контрольная порча и временная test injection удалены. Исходные `turn.ts` и `turn-admission.ts` восстановлены побайтно; SHA256 до и после совпадают. Raw RED/GREEN logs и полный отчёт исполнителя находятся в `output/priority-coverage/task-1-*`.

Новая opt-in проверка включена в [CI](../.github/workflows/ci.yml) рядом с существующими native auth/quota/portable fixtures. Настройка CI проверена локально; удалённый workflow в этом этапе не запускался.

## Права на уровне настоящих HTTP-обработчиков

[route-authority.test.ts](../tests/route-authority.test.ts) использует настоящее Next cookie request storage и мигрированный PGlite. **60 runtime registrations** включают 48 строк отказов, шесть разрешённых публичных операций, два родительских matrix tests и четыре отдельных сценария:

- Owner, public reader и foreign administrator проходят буквальную таблицу статусов для public/private campaigns. Проверяются act, request polling, turns, checkpoint read/create/delete, fork, copy, memories, memory search/reindex и Markdown/portable JSON export.
- После отказов проверяются исходное содержимое turns/memory/checkpoints/request, количество sessions/jobs/settings/quota rows, отсутствие provider fetch и отложенной работы. Отдельный malformed-body control доказывает, что запрет применяется до чтения тела.
- Разрешённые публичные чтения и копии имеют положительные controls; каждая копия получает владельца читателя и private visibility. Owner читает private данные, экспортирует portable JSON, создаёт checkpoint/fork, повторяет fork без дубля, удаляет checkpoint и фиксирует offline preset turn с последующим polling.
- Реальный owner reindex/search использует synthetic transport, настоящие записи индекса и квоты, сохраняя соседнюю кампанию. Иностранные operational обращения отклоняются без дополнительных эффектов.
- Во время чтения тела copy/act событийный барьер позволяет выполнить настоящий logout. Продолжение старого запроса получает `IDENTITY_CHANGED`/401, не создаёт кампанию/ход и освобождает owner activity; последующее публичное чтение новым guest principal разрешено.

Временное разрешение public reader в owner policy обнаруживается по лишнему polling-доступу, прочитанному телу и записи AI settings ещё до конечного отказа act. Production policy восстановлена побайтно; raw logs и детали — `output/priority-coverage/task-2-*`.

Owner export control выявил дефект общего [тестового адаптера](../tests/helpers/accounts-db.ts): `Date → ISO Z` несовместим с Drizzle timestamp-without-time-zone mapping, а сохранение PGlite Date без parser override сдвигает время на timezone хоста. Адаптер теперь передаёт timestamp wire text через запросившие его parsers Drizzle для OID 1114/1184. Настоящий handler export проверяет буквальные `2026-10-09T10:00:00.000Z` и `2026-10-09T10:00:01.000Z`. Отказ `INVALID_DOCUMENT` до исправления сохранён в `task-2-export-red.log`; production exporter не изменён.

## Изоляция карты

[location-ops-db.test.ts](../tests/location-ops-db.test.ts) содержит **6 runtime cases**. Три вызывают настоящий SQL executor, три — настоящий `performTurn` consumer:

- Две кампании имеют одинаковые названия локаций, но разные UUID. Discover, current insert/set и connect изменяют только intended campaign; connections содержат оба правильных local endpoints, foreign rows побуквенно не меняются.
- Смешанный local/foreign маршрут не добавляет чужой UUID к local adjacency.
- Разрешённый переход на local `Док` согласует API applied changes, world state, сохранённый narrator turn, симметричные связи и location memory event.
- Неоднозначное local имя и explicit foreign UUID не создают phantom location change, event или link; проверены все local/foreign map columns.

В схеме нет уникального столбца slug/name. Поэтому проверяется настоящая неоднозначность ссылок; вымышленный конфликт SQL constraint не используется. Внутренний void executor `loc.setCurrent` предполагает уже принятый reducer operation: прямой чужой ID может очистить local current flags, но публичный consumer отбрасывает такой ID до dispatch. Это ограничение прямо сохранено как результат этапа09.10; product API дефект тогда не воспроизведён. **Обновление10.10:** [внутренний executor исправлен](location-current-fix-2026-10-10.md), direct foreign/missing target теперь сохраняет всю карту без reducer-only предусловия.

Удаление campaign predicate из connect endpoint selection приводит к появлению foreign UUID в local adjacency и к ожидаемому сбою. Исходный executor восстановлен с совпадающим SHA256; raw logs и подробные оракулы — `output/priority-coverage/task-3-*`.

## Проверка и доставка

Исходный полный `npm test`: **687/687**, 0 fail/cancelled/skipped, exit 0. Итоговый `npm run test:coverage`: **753/753**, 0 fail/cancelled/skipped, exit 0, **359897.1406 ms**. Это **+66 ordinary registrations**: route60 и map6. Native aggregate исполнен отдельно после усиления replay assertions: **8/8**, 0 skipped, exit 0, **7760.2916 ms** — previous3 плюс new5. Число registrations включает nested subtests и родительские регистрации, а не число assertions.

`npm run typecheck`, `npm run lint` и `npm run check:docs` завершились exit 0. Текущий snapshot содержит 110 ordinary test files и четыре opt-in native fixtures. LCOV содержит **172 loaded / 56 not-loaded source files**; raw V8/tsx counters не объявляются original-TypeScript или whole-application покрытием. [JSON-карта](testing/coverage-inventory-2026-10-09.json) обновляет AST references, test names/lines, counters и сохраняет предыдущие 674/679/687 runs с per-module history и hashes.

Отдельный PostgreSQL остановлен после проверенного owned PID/data directory: **0 fixture schemas, 0 public tables, 0 listeners, 0 owned processes**, PID file отсутствует. Raw suite/native/type/lint/docs/mutation logs, schema cleanup и reproduce scripts сохранены в `output/priority-coverage/`. Независимое review: spec PASS и code/test quality PASS, оставшихся actionable findings нет. В основной `E:\Projects\RPG_arena` перенесены 11 source/test/doc файлов с проверкой SHA256; там повторно прошли новые66/66 scenarios, typecheck и lint. Полные753 и native8 исполнялись в изолированной среде; доставка сверяет побайтно идентичные tests/source. После финальной документации main checker завершился exit0:69 docs/261 local links. Delivery manifest и logs сохранены рядом с evidence.

## Пределы и следующие P1

Обычный suite исполняет реальные services/handlers на PGlite, но не доказывает несколько серверных PostgreSQL connections. Native fixtures исполняют relational admission/commit на PostgreSQL 16.15, применяя **19/20 migrations** и сохраняя immutable `0006_database_memory_search.sql` без изменений. PostgreSQL runtime не содержит pgvector; native vector search и полный extension migration replay не заявляются. PGlite применяет все миграции с bundled extensions.

Native barriers используют independent connections в одном test process; поведение при убийстве worker process, сетевом разрыве БД и рестарте PostgreSQL остаётся отдельной проверкой. Synthetic provider responses подтверждают server contracts; live качество моделей и настоящий browser lost-response recovery не проверялись. Не использовались реальные campaigns, оплачиваемые провайдеры или deployment.

Следующие приоритеты из действующей матрицы: password-change/claim races, mixed-owner worker fairness и compaction CAS, browser disconnect/import retry, OAuth callback identity и two-build PWA lifecycle. Разметка независимого AI corpus требует отдельного gold-review процесса; authored fixtures не объявляются independent gold.
