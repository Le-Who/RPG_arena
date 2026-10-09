# Аудит покрытия и исправление подтверждённых дефектов

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Изучить активную кодовую базу, оценить качество существующих тестов, исправить воспроизведённые дефекты и сохранить проверяемую схему покрытия.

**Architecture:** Проверять поведение через существующие интерфейсы, сохраняя настоящие reducers, HTTP handlers, SQL и миграции. Подменять только внешнюю сеть и подключение к одноразовой PGlite-базе. Разделить аудит и исправления по независимым файлам; итог проверить свежим независимым review.

**Tech Stack:** Next.js 16.3.8 (baseline 16.3.5), TypeScript, node:test/tsx, PostgreSQL/PGlite, Playwright Chromium.

**Spec:** Запрос владельца от 09.10.2026: полный аудит, схема необходимых тестов, оценка релевантности/объективности/правильности, параллельные сабагенты с reasoning не ниже high; дополнительно разрешено исправлять найденные проблемы до покрытия тестами. Контракты проекта: [CODING_STANDARDS.md](../../../CODING_STANDARDS.md).

## Global Constraints

- Сохранять preset/free и d20/rules-light/narrative; повседневная жизнь и социальные сцены равноправны приключениям.
- Не обращаться к реальной БД и платным провайдерам. Прогоны node:test используют tests/helpers/test-environment.ts.
- Не менять исторические миграции, журнал Drizzle и readiness ради локального окружения.
- Не принимать намерение, model verdict или произвольный текст за подтверждённый канон; сверять финальный рассказ с окончательным состоянием.
- Сохранять ownership, request idempotency, admission, lease/fencing и атомарный commit.
- Пользовательские сообщения — на русском; ключи не должны попадать в ошибки, логи и результаты evaluations.
- Не объявлять импорт модуля, успешный mock или структурный PASS доказательством покрытия ветвей, качества модели или production readiness.

## Review Focus

- Передача предмета, продвижение часов, expiry состояний и социальные изменения должны присутствовать в состоянии, которое видит финальная проверка повествования.
- Неоднозначные ссылки и null/primitive элементы model JSON не должны менять канон или аварийно ломать parser.
- Русские слова о ресурсах, предметах и переходах не должны обходить существующий фильтр семантической памяти; легитимные факты о мире должны сохраняться.
- Поток, не реагирующий на fetch AbortSignal, должен завершаться по общему deadline; чтение должно освобождаться при ошибке и превышении размера.
- Нулевой usage, произвольная ошибка с synthetic secret и изменение выбранного провайдера не должны приводить к выдуманным метрикам, утечке или необъективной оценке.

## Task 1: Полная инвентаризация и качество существующих проверок

**Files:** src/, tests/, scripts/, drizzle/, deploy/, .github/workflows/ci.yml; документация контрактов; итог docs/test-coverage-audit-2026-10-09.md и docs/testing/.

**Interfaces:** Сопоставление production path → непосредственно вызывающие тесты → уровень проверки → контракт → существенный пробел. Статический граф imports отдельно от измеренного выполнения.

- [x] Прочитать правила проекта, тестовый bootstrap, package scripts и соответствующие Next.js guides.
- [x] Запустить исходные typecheck, lint, документацию, полный npm test и изолированную production-сборку.
- [x] Закрыть перечень реально изученных файлов для всех доменов; исключения объяснить явно.
- [x] Зафиксировать качество оракулов, негативные проверки, ограничения PGlite, CI и synthetic evaluations.
- [x] Сохранить файловую карту и приоритетную схему новых проверок.

## Task 2: Финальное состояние хода и безопасные reducers

**Files:** src/lib/turn.ts, src/lib/narrative-*.ts при необходимости, src/lib/resolution.ts, src/lib/world-life.ts; tests/narrative-turn-integration.test.ts, tests/resolution.test.ts, tests/world-life.test.ts.

**Interfaces:** performTurn(input, runtime) сохраняет только проверенный окончательный результат. applyLife(input) не мутирует входные коллекции. parseResolution(raw) безопасно отклоняет неподходящие элементы. Неоднозначная ссылка на предмет даёт rejected consequence без списания.

- [x] Добавить регрессии на verifier snapshot после передачи/expiry и финальные narration/choices/state; увидеть RED на исходной реализации.
- [x] Добавить независимые буквальные ожидания для null/primitive proposals, ambiguous item prefix и неизменности touchedItemIds; увидеть RED.
- [x] Исправить причины минимально, сохранив repair/guard/commit contracts.
- [x] Проверить focused tests и дать отчёт с командами RED/GREEN.

## Task 3: Каноническая память, честная проверка импорта и CI

**Files:** src/lib/memory.ts, tests/upgrade.test.ts, tests/legacy-settings-import.test.ts, .github/workflows/ci.yml; дополнительные test helpers только при необходимости.

**Interfaces:** normalizeExtractedFacts(raw, narration, playerAction) исключает state-owned resource/item/location facts и сохраняет обоснованные semantic facts. Проверка rollback вызывает настоящий importer. CI запускает существующие native PostgreSQL auth/quota tests только в disposable service.

- [x] Добавить русские negative controls и похожие допустимые слова, проверить RED.
- [x] Исправить Unicode matching без расширения фильтра на все упоминания места или предмета.
- [x] Заменить ручную SQL-имитацию rollback поведенческой проверкой production пути либо честно переименовать и добавить настоящее покрытие.
- [x] Подключить opt-in auth/quota regressions к уже существующей отдельной PostgreSQL fixture CI.
- [x] Проверить affected tests; отсутствие локального native PostgreSQL отметить отдельно от PGlite успеха.

## Task 4: Провайдеры, изображения и объективность оценки

**Files:** src/lib/gemini-transport.ts, src/lib/visual-provider.ts, src/lib/visuals.ts, scripts/eval-story-drafts.ts, tests/fixtures/typesafe-scenarios.json; tests/gemini-transport.test.ts и новые focused provider/evaluation tests.

**Interfaces:** Transport соблюдает общий deadline и сохраняет фактический usage, наружу отдаёт только безопасные коды ошибок. Media reader отменяет ненужное чтение; visual error не сохраняет произвольный текст исключения. Evaluation runner исполним через текущий npm script, требует явного live opt-in, учитывает identity и не объявляет корректную внешнюю модель ошибкой из-за старого fixed ID.

- [x] Добавить и подтвердить RED для stalled body, отмены, arbitrary secret marker, zero usage, oversize image cancellation и visual error persistence.
- [x] Проверить актуальную официальную документацию для затронутых provider contracts; не менять модели и API поколение без необходимости.
- [x] Исправить подтверждённые причины, а не ослаблять тесты.
- [x] Проверить executable evaluation runner изолированным HTTP fixture; отсутствие live opt-in должно прекращать работу до сети.
- [x] Устранить подтверждённую неоднозначность temporal gold fixture; зафиксировать пределы synthetic/heldout evidence.
- [x] Проверить focused tests и дать отчёт RED/GREEN.

## Task 5: Независимая перепроверка и итог

**Files:** итоговый diff, отчёт покрытия, docs/superpowers/plans/roadmap.md и документы изменённых контрактов.

**Interfaces:** Проверяемое разделение исправленных дефектов, уже защищённых инвариантов и оставшегося планового покрытия.

- [x] Получить свежий независимый review исправлений, тестов и доказательности карты.
- [x] Устранить существенные замечания и проверить именно изменённые сценарии.
- [x] Выполнить итоговые npm test, typecheck, lint, check:docs, production build и affected isolated browser checks.
- [x] Обновить документацию и roadmap без изменения существующих task IDs.
- [x] Сопоставить итоговый перечень файлов и тестов с картой, проверить ссылки и git diff.
- [x] Доставить результат с фактическими числами, ограничениями и путями к артефактам.

## Исходные доказательства

- HEAD: ba6451df90dba053e572a31b4cf51b4bff695f5d; до аудита tracked checkout чистый.
- npm test: 596 pass, 0 fail, 0 skipped, 188980.7885 ms.
- npm run typecheck, npm run lint, npm run check:docs: exit 0; docs checker 63 files / 202 local links.
- Production build с фиктивным loopback DATABASE_URL и отключёнными auto-migrate/credentials: exit 0.
- scripts/app-update-guards-browser.ts с synthetic bootstrap: exit 0, Chromium fixture без БД и провайдера.
- На машине не обнаружены docker, psql, pg_ctl; native PostgreSQL проверки локально пока недоступны.

## Рабочие решения

Исправления ограничены воспроизведёнными дефектами; продуктовые возможности, новые модели и изменение архитектуры приложения не входят в этот аудит. Параллельные изменения допустимы только по непересекающимся файлам; общий прогон и итоговый review выполняет координатор.

## Итоговые доказательства

- Полное текущее test:coverage: 679/679 pass, 0 fail/cancelled/skipped, 172540.8706 ms; raw V8/tsx LCOV: 162 loaded / 66 not loaded src. Static call sites: 596; ordinary test files: 108.
- Full source-reading union: 228/228 src; final independent review и последняя build-identity delta — approval with limits, подтверждённых открытых P0/P1/P2 нет.
- TypeScript, ESLint, check:docs (66 files / 237 links) и sanitized Next16.3.8 production build прошли. Actual default build/start/restart/client parity и browser story/turn + standalone gallery/update guards имеют отдельные completed producers.
- 52 code/doc paths доставлены в исходный E:\Projects\RPG_arena с SHA256 equality; npm ci и повторные typecheck/lint/docs/build/metadata-start в основном каталоге прошли. Full test не повторялся после копирования идентичного snapshot.
- Real campaign DB, paid/live providers, unskipped native PG и deployment не выполнялись; три native gates включены в isolated CI. Runtime npm audit: 0; dev toolchain: 9 (4 moderate / 5 high).
- Scheme, ограничения и concrete backlog: docs/test-coverage-audit-2026-10-09.md и docs/testing/. Локальная доказательная база: output/test-audit/, output/test-coverage.lcov, текущие browser artifacts. Исторический preliminary674 сохранён отдельно.
