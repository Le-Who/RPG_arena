# Аудит legacy-кода и зависимостей — 18 октября 2026

## Область и метод

Запрос: найти устаревший и безопасно удаляемый код, убрать лишние зависимости, воспроизвести найденные неисправности тестами и исправить их. Проверка выполнена в существующем рабочем каталоге с сохранением исходных незакоммиченных изменений checkpoints, world-life, связанных тестов и документации. Эти исходные изменения не считаются результатом данного аудита.

Статический обход TypeScript AST охватил 443 активных TS/JS-файла в `src/`, `scripts/`, `tests/` и исполняемых конфигах. Итоговый файловый inventory: 227 source-файлов, 68 scripts и 160 test/helper/fixture-файлов; эти числа включают CSS/JSON и не складываются с AST count. Отдельно проверены достижимость от Next entrypoints, CLI и тестов, потребители экспортов, динамические CSS-классы, публичные assets, все 21 прямое объявление зависимостей и lockfile. Ручная проверка сосредоточена на turn/reducer/memory, providers/settings/secrets/identity, UI/hooks/PWA, миграциях и эксплуатационных scripts. Название `legacy` и отсутствие прямого импорта сами по себе не считались основанием для удаления.

Сабагенты: `gpt-6.1-sol`, reasoning `high` для трёх самостоятельных областей. После реализации выполнены независимые перекрёстные проверки. Локальные Next guides прочитаны из установленного `node_modules/next/dist/docs/`. Значения `.env` не использовались; реальные базы кампаний и платные провайдеры не вызывались.

## Удалено

| Объект | Доказательство и замена |
| --- | --- |
| `src/lib/world-map.ts` | Старый алгоритм карты имел единственного потребителя: семь тестов самого старого алгоритма в `experience-v25.test.ts`. Действующий компонент использует `world-graph.ts`; его проверки геометрии, видимости, рёбер и клавиатуры сохранены. Два теста настроек чтения из `experience-v25.test.ts` сохранены. |
| `dotenv` | Нет импортов или preload-потребителей в активном source/scripts/tests/deploy. CLI уже использует встроенные Node `--env-file` / `--env-file-if-exists`, Next загружает своё окружение самостоятельно. Пакет и его lock entry удалены. |
| Прямое объявление `baseline-browser-mapping` | Приложение пакет не импортирует. Он остаётся транзитивной зависимостью Next и Browserslist на прежней зафиксированной версии. |
| Runtime-объявление `@playwright/test` | Используется только browser/test tooling. Перенесён в `devDependencies` без обновления версии `1.63.0`. Next объявляет его optional peer, поэтому lock сохраняет `devOptional`-ветку; отсутствие всех Playwright bytes в production install не заявляется. |
| `drizzle.config.json` | Остаточный конфиг уже удалённого Drizzle Kit. Действующие миграции читают журнал через `drizzle-orm/migrator` и `scripts/lib/apply-migrations.ts`; Docker, worker и startup его не используют. SQL и журнал не менялись. |
| Восемь неиспользуемых экспортов | `STAT_MODS`, `envKeys`, `buildCompactionSystemPrompt`, `CONTEXT_BUDGET`, `isCampaignMode`, `STORY_DRAFT_RESPONSE_SCHEMA`, `TYPE_SAFE_ENDPOINT`, `AGENDA_STATUS_LABELS`. Для каждого выполнен поиск потребителей по source/scripts/tests и проверка namespace/dynamic use. Существующие действующие prompts, budgets, profiles и transport endpoint сохранены. |
| Реэкспорт provider API из `visuals.ts` | Все реальные потребители provider-функций и типов уже импортируют `visual-provider.ts` непосредственно. |
| 48 CSS selector rules в шести файлах | 17 семейств классов от старых memory metrics, search dialog, map overlay, footer/live indicators и offline shelf. Проверены source, scripts, tests, public HTML и динамическое построение классов. Текущие `map-dialog`, `command-dialog` и `is-${change.tone}` сохранены. |

## Исправленные неисправности и регрессии

| Граница | Воспроизведённая ошибка | Исправление и тесты |
| --- | --- | --- |
| Последовательные изменения NPC | Два изменения отношений читали исходный snapshot; вторая заметка теряла первую. Более поздняя операция могла оживить NPC, погибшего ранее в том же batch. Независимый review воспроизвёл рассогласование памяти на последовательности +10,+5. | Изменения используют локальную копию развивающегося состояния. Общий лимит отношений профиля за ход и абсолютные границы ±100 сохранены; applied deltas отражают реально принятые значения. Уже созданное событие памяти обновляется после малых изменений того же NPC, сохраняя прежнюю заметку. Одиночные малые изменения и другие NPC не создают лишних событий. `resolution-batch-p2.test.ts`. |
| Квесты и объекты сцены | Завершённый в начале batch квест мог открыться снова; повторное закрытие ранее открытой двери пропускалось, поскольку исходная дверь уже была закрыта. | Последующая операция видит принятое предыдущее состояние. Проверены terminal status, последовательность ops, чистота входа и выбор финального события для памяти. `resolution-batch-p2.test.ts`. |
| Новые сущности с одинаковым ключом | Несколько insert с одинаковым ключом попадали в applied changes и память, хотя SQL `ON CONFLICT DO NOTHING` сохранял только первый. | Повторное создание одного ключа в batch отклоняется до фиксации ложных последствий. Проверены квесты, NPC и объекты сцены. `resolution-batch-p2.test.ts`. |
| Нормализация извлечённой памяти | JSON-объекты с затенённым `toString` в `type`/`importance` вызывали `TypeError` и срывали обработку корректного соседнего факта. | Тип проверяется до coercion; object-valued importance получает действующий default 55. Подтверждены сохранение корректных siblings и evidence. `memory-normalization-boundaries.test.ts`. |
| Внешний текстовый transport | Fetch, игнорирующий abort, или зависший async `onAttempt` удерживали вызов после отмены/дедлайна. Дробные и небезопасные token counts попадали в учёт. | Fetch и telemetry ограничены сигналом; позднее тело отменяется; terminal accounting не дублируется. Usage принимает неотрицательные safe integers, включая ноль, иначе использует оценку. `text-provider-deadlines.test.ts` и действующие provider/quota suites. |
| Каталог изображений | У зависшего после headers body не срабатывал срок; ранний отказ по размеру не отменял незавершённое тело ответа. | Reader отменяется по сигналу и при выходе, сохраняются лимит 512 KiB и allowlist parser. `visual-model-catalog-boundaries.test.ts`. |
| OAuth discovery/token body | Reader не реагировал на общий срок, а ожидание незавершающегося `cancel()` могло удерживать отказ по размеру. | Тот же timeout действует на чтение; отмена не продлевает вызов. Проверки владельца, state, PKCE, redirect и response allowlist сохранены. `pollinations-oauth-deadlines.test.ts` и actual-handler tests. |
| Embeddings | Fetch, body и запись telemetry могли зависать за пределами provider deadline. | Операции ограничены сигналом, тело очищается, quota reservation и однократный учёт сохраняются. Добавлен лимит wire JSON 16 MiB. `embedding-provider-deadlines.test.ts` использует disposable PGlite и настоящий quota/log SQL. |
| CLI evaluations и GC | В первом полном прогоне существующий CLI-тест завис на первом незавершённом HTTP body. Inline `AbortSignal.timeout()` мог потерять сильную ссылку после получения headers; при GC deadline исчезал во время `response.json()`. Такой же шаблон обнаружен в четырёх sibling evaluations. | Пять скриптов используют общий `scripts/lib/read-response-json.ts`, который владеет сигналом до окончания чтения и отменяет reader при abort. Реальный CLI regression теперь запускает child-only forced GC; сохранены 200 ms на запрос, 24 вызова, общий предел 8 s, privacy/redirect/model/report assertions. Отдельный synthetic-stream worker проверяет helper. |
| Поиск записей истории | Enter отправлял semantic search при отключённых embeddings; поздний ответ восстанавливал старые результаты после Reset. | Guard перенесён в саму операцию поиска; Reset инвалидирует request counter. `scripts/story-records-search-browser.ts`: реальный компонент/API client, desktop/mobile, клавиатура и контролируемый поздний HTTP-ответ. |

Новые поведенческие регрессии сначала падали на соответствующем старом поведении, затем прошли после исправлений. Тесты старого алгоритма карты удалены вместе с его реализацией; они не подменяют действующее покрытие новой карты.

В README исправлен устаревший список миграций: вместо шестнадцати теперь отражены все двадцать фактических journal entries `0000`–`0019`, включая text provider settings, owner queue, performance и durable visual quota. Сами SQL/journal не менялись.

## Сохранённая совместимость

- `searchMemoryLegacy` — рабочий fallback при rolling deploy до появления SQL search capabilities; не мёртвый код.
- Legacy settings, явный offline profile assignment и plaintext import/rotation opt-in — нужны для контролируемого переноса старых данных без ослабления identity/AAD.
- Старые v1 checkpoints, strict portable allowlist, provenance и ID remapping — сохранены.
- Исторические SQL `0000`–`0019`, snapshots и журнал — сохранены. Неизменяемая `0006` не переписывалась.
- `jev-mechanics.ts` — намеренно изолированный evaluator для уже записанного JEV-3b; отсутствие вызова из игрового хода соответствует roadmap.
- `secret-rotation.ts` и `typesafe-eval.ts` — CLI-инструменты, достижимые от scripts; сохранены.
- Schema exports без именованных потребителей используются через `Object.values(schema)` в readiness и через raw SQL. Таблицы auth/session/quota/performance/queue не удалялись.
- Публичные поля TypeSafe settings, включая `envOverride: false`, оставлены как действующий API/fixture contract. Недостижимые env UI-ветки не удалялись ценой непроверенного изменения публичного формата.
- Все 38 component modules и 13 public assets имеют потребителей. Старые по названию browser/evaluation scripts остаются эксплуатационными и регрессионными инструментами.
- `preset`/`free`, `d20`/`rules-light`/`narrative`, необязательные бой/опасность/броски и русский интерфейс сохранены.

## Зависимости, которые не обновлялись автоматически

Последующее исправление оставшейся ESLint high-цепочки описано в [отдельном отчёте от 18 октября](eslint-dependency-remediation-2026-10-18.md). Ниже сохранены результаты первоначального legacy-аудита до этого исправления.

`npm outdated` сохранён как inventory, а не как список обязательных обновлений. Действующие Next/React/Drizzle/PostgreSQL client/TypeScript/Tailwind/PGlite не становятся legacy только из-за появления нового релиза. Изменения ограничены доказанно лишними декларациями и пакетом `dotenv`.

На дату аудита полный `npm audit` сообщает пять связанных high entries в dev lint chain `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`. [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) указывает отсутствие patched release. Предложенный npm downgrade `eslint-config-next` до 14-й основной версии не совместим с действующим Next 16 и не применялся.

ESLint `9.39.4` помечен deprecated. При этом установленные React/JSX a11y plugins исключают ESLint 10 из peer range. [Официальная миграция ESLint 10](https://eslint.org/docs/latest/use/migrate-to-10.0.0) содержит удаление старых plugin APIs; принудительный upgrade с игнорированием peers не считается безопасной очисткой. Это остаётся явным ограничением dependency-аудита.

## Итоговая проверка

Общие проверки выполняются на физической временной копии с чистой установкой по существующему lockfile, без `.env`, с OS environment allowlist и фиктивным loopback `DATABASE_URL`. Содержимое source/test/script/config сверяется по SHA-256. Начальный прогон из рабочего каталога остановлен до завершения: параллельно уже появились изменения, поэтому он не выдаётся за чистый baseline или итоговый full run.

Первый полный прогон на чистой копии выполнен штатным `npm test`: 1139 tests, 1138 pass, один fail — `story evaluation deadline aborts an unfinished body after headers and partial JSON arrive`, `CLI_TEST_TIMEOUT` после 10022 ms. Этот результат сохранён в `output/legacy-audit-2026-10-18/first-full-test.log`; он не объявляется успешным. Повтор с child-only `--expose-gc` и GC каждые 10 ms дал воспроизводимый RED: один request/header/partial body, ноль закрытых bodies. После исправления независимый helper+CLI run прошёл 15/15; фактическое чтение незавершённого HTTP body завершалось приблизительно за 5.2 s при неизменном пределе 8 s.

Повторный полный прогон использует ту же коллекцию ordinary test files и тот же защитный loader, с двумя отдельными процессами файлов вместо одного. Штатный npm-скрипт остаётся последовательным. У ordinary fixtures собственные PGlite instances и случайные временные каталоги; файловые записи проверены на отсутствие общих изменяемых fixtures. Точная команда:

```sh
node --import tsx --import ./tests/helpers/test-environment.ts --test --test-isolation=process --test-concurrency=2 tests/*.test.ts
```

Итоговый повторный полный набор: **1141/1141**, fail/cancelled/skipped/todo — **0**, exit **0**. Добавлено 31 ordinary registration; удалены семь проверок удалённого алгоритма карты. По отношению к предыдущим 1117 cases: `1117 + 31 - 7 = 1141`. Усиленный forced-GC CLI-тест — прежняя registration, он не засчитан как новый тест.

| Проверка | Фактический результат |
| --- | --- |
| Чистый `npm ci --ignore-scripts --no-audit --no-fund` | Exit 0, существующий lockfile; deprecated warning ESLint сохранён в отчёте о зависимостях |
| Полный ordinary набор после всех исправлений | 1141/1141, exit 0; те же файлы/loader, два process-isolated worker |
| `npm run typecheck` | Exit 0 на финальных исходниках |
| `npm run lint` | Exit 0 на финальных исходниках |
| `npm run build` | Exit 0, Next 16.3.8, штатный Turbopack; после финального script/helper изменения |
| `npm run check:docs` | Exit 0, 87 файлов, 356 локальных ссылок, актуальные npm commands и migration ledger |
| StoryRecords Chromium desktop/mobile | 8/8 checks, без page errors/overflow |
| Текущая карта Chromium desktop/mobile/keyboard | 16/16 cases |
| Независимые заключительные проверки | Core 39/39; embeddings/quota/memory 14/14; GC helper/actual CLI 15/15 |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Полный `npm audit` | 5 high entries в одной dev lint chain, без patched braces release |
| Сравнение lockfile с HEAD | Удалён только пакет `dotenv`; новых пакетов, изменений version/resolved/integrity остальных пакетов нет; root declarations совпадают с `package.json` |

Зафиксированы 598 файлов проверочной копии, из них **505 executable/config/SQL/public inputs** побайтно совпадают с основным checkout и оставались неизменными в итоговых gates. Документация обновлена отдельно после получения результатов. Предыдущие LCOV и coverage inventory относятся к своим прежним прогонам; проценты покрытия этим этапом не переиздавались.

Raw результаты находятся в `output/legacy-audit-2026-10-18/`: `final-test.log/json`, `first-full-test.log/json`, `final-typecheck.log/json`, `final-lint.log/json`, `final-build.log/json`, `final-check-docs.log/json`, `clean-install.log`, `module-audit.json`, `export-audit.json`, `validation-input-hashes.json`, `lockfile-comparison.json` и npm audit/outdated JSON. Browser evidence: `output/playwright/story-records-search/` и `output/playwright/world-map-keyboard-p2/`; CSS/component evidence: `output/ui-dead-style-audit/`.

Локальные HTTP fixtures/PGlite и browser executions сохраняют свои границы: они не доказывают качество live-моделей, native PostgreSQL contention, production deployment или ручную screen-reader совместимость. Provider deadline guards ограничивают HTTP/body/telemetry; предварительные DB-чтения владельца и настроек остаются обычными SQL-операциями, а уже начатая telemetry SQL-операция может завершиться после тайм-аута вызывающего кода.
