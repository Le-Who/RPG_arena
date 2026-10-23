# Третий независимый аудит и разделение CI — 23 октября 2026

Исходный commit: `9112841ef7a5341fe259a8cb15a65becb1c3c941`. Три отдельных субагента проверяли identity/persistence, turns/state/queues и CI/tooling. Независимые ревьюеры проверяли общий patch и смежные вызовы. Исправления основаны на воспроизводимых отказах; изменения архитектуры продукта и обновление зависимостей не требовались.

## CI и фактический деплой

В исходном успешном [run 39964234121](https://github.com/Le-Who/RPG_arena/actions/runs/39964234121) `verify` занимал 16 минут 9 секунд. Последовательный `npm test` занимал 10 минут 43 секунды, native PostgreSQL suites — около 20 секунд, production build — 26 секунд, браузерная часть после сборки — около 3 минут 49 секунд. Отдельная map/dialog matrix завершалась за 2–3 минуты.

Production deployment того commit получил success в 13:48:47 UTC, до окончания `verify` в 14:04:25. Предыдущий commit `911c6548` также получил успешный Vercel deployment при ошибке unit-тестов в [run 39961977524](https://github.com/Le-Who/RPG_arena/actions/runs/39961977524). GitHub сообщил `Branch not protected` для `main` и пустой список repository rulesets. Следовательно, текущая блокировка деплоя результатами CI не подтверждена; Vercel Git deployment уже независим. Удалённые deployment settings не изменялись.

Новая структура сохраняет все прежние проверки:

- `Chronicle verification`: параллельные `static`, четыре `unit-tests` shard, `postgres`, `build`; стабильный итоговый check `verify` требует success каждой зависимости.
- Shards распределяются встроенным `--test-shard=N/4`; внутри отдельного runner сохранён `--test-concurrency=1`, необходимый для текущих PGlite fixtures. `fail-fast: false` сохраняет результаты остальных shard при ошибке одного.
- Native PostgreSQL correctness suites остаются обязательными, включая performance suite с SQL rollback, advisory locks и лимитами. Применение полной migration history и replay сохранено.
- `Chronicle supplementary checks`: документация, трёхбраузерная map/dialog matrix, Chromium fixtures/latency, retry/service-worker updates и полный production Next lifecycle. Запуски сохранены на каждом push/PR и вручную; ошибки не подавляются через `continue-on-error`.
- Lifecycle и two-build update suite работают в разных checkout/job. Их `.next` и одноразовые БД не пересекаются. Сохраняются screenshot artifacts и log lifecycle-сервера.
- Concurrency group включает имя workflow, поэтому дополнительные проверки не отменяют основные.

`vercel.json` и обязательный `build:deploy` не менялись: ошибки миграций и сборки продолжают блокировать сам deployment. Если оператор включит Vercel Deployment Checks, основному результату соответствует стабильный check `verify`; дополнительные checks выбираются независимо. Операционный контракт обновлён в [руководстве развёртывания](deployment-operations.md).

## Подтверждённые дефекты

### Portable import: PostgreSQL-несовместимые строки

JSON разрешает экранированный NUL и одиночные UTF-16 surrogates; PostgreSQL text/JSONB их не сохраняет. Файл с правильной checksum проходил parser и получал `500 INTERNAL`. Preflight теперь отклоняет такие строки и ключи как `400 INVALID_DOCUMENT`; отдельный override title отклоняется как `400 INVALID_INPUT` до записи кампании. Строгая allowlist сохранена. HTTP/PGlite regression проверяет отсутствие session/import/activity после отказа и положительный round-trip русского текста и emoji.

### Semantic memory: обход ресурсной границы через тип факта

Модель могла вернуть «Герой получил 500 XP» как `character`, минуя фильтр числовых ресурсов для `event`/`world`. Worker записывал канонический semantic fact и embedding outbox при неизменном числовом состоянии. Ресурсные шаблоны теперь проверяются независимо от типа. Более широкая эвристика предметов/движения сохраняет прежнюю область применения: её расширение на character/NPC было отклонено независимым review из-за ложных отказов обычным социальным фактам. Регрессии сохраняют допустимого соседа и бытовые положительные примеры.

### Scene object: неверная локация в памяти

После перемещения героя update объекта по стабильному ref сохранял правильную локацию scene object, но memory event называл текущую локацию героя. Заголовок и содержание события теперь используют `existing.locationName`. Регрессия проверяет переход и update в одном ходе, согласованность operations/memory и отсутствие мутации входного снимка.

### Очереди: сравнение UTC deadlines

Scheduler сравнивал persisted UTC `timestamp without time zone` с `timestamptz now()`, что зависело от timezone SQL-соединения. Будущая работа выбиралась раньше времени либо наступившая пропускалась. Для pending retry и processing lease обеих очередей используется `now() AT TIME ZONE 'UTC'`; сравнение provider key expiry типа timestamptz сохранено. Проверены Tokyo/New York и будущие/наступившие deadlines. Старый scheduler fixture приведён к фактическим типам production-схемы.

### Очереди: сроки новых semantic/embedding заданий

SQL `DEFAULT now()` для поля без timezone записывал локальные часы соединения. При enqueue в Tokyo задание получало искусственную задержку на девять часов относительно worker UTC. Producers явно задают UTC instant через `Date`; historical migrations не переписываются. Проверяются semantic enqueue, portable/copy и checkpoint fork producer paths.

### Browser tooling: listener после launch failure

В десяти CI-скриптах HTTP fixture/proxy уже слушал порт, когда запуск browser мог завершиться ошибкой до входа в `finally`. Процесс оставался жив до job timeout. Общий узкий helper закрывает connections/listener при синхронной или асинхронной ошибке launch и повторно выбрасывает исходную ошибку. Успешный browser и HTTP fixture остаются доступны. Регрессия с отсутствующим executable до исправления требовала принудительного завершения child, после исправления child сам завершался с code 1.

## Проверка и границы

Для исправлений воспроизведены RED → GREEN, используются реальные handlers/reducers, PGlite и HTTP listeners. Проверка CI включает `actionlint`, сравнение inventory всех 27 прежних regression/browser команд и исполнение итогового shell gate для 16 success/failure/cancelled/skipped сочетаний отдельных зависимостей.

До commit выполнены следующие локальные проверки:

- Последовательный основной test run: **1519 passed, 0 failed, 0 skipped**, exit 0.
- Финальный focused run: **28/28**, включая появившиеся после начала основного прогона новые `browser-fixture-launch` и `embedding-producer-timezone`, все normalization boundaries и actual semantic worker.
- Независимый финальный reviewer на `gpt-6.1-sol`: **57/57**, новых замечаний после исправлений нет.
- Production `next build`, последующий `tsc --noEmit`, общий ESLint и повторная проверка изменённых файлов: exit 0.
- Реальный Chromium: gallery/update guards — exit 0. Все десять изменённых browser scripts с отсутствующим executable самостоятельно завершились с code 1 без forced kill.
- Документация, `actionlint` обоих workflow, inventory команд и shell gate: exit 0. Удалённые workflow проверяются после push; локальный успех не подменяет их результат.

Локальные прогоны используют Node 22.23.3, тестовый preload, одноразовые данные и синтетический provider transport. Реальные provider credentials, платные evaluations и production-БД не используются. Результат не является проверкой качества живых моделей или всех возможных сочетаний UI.
