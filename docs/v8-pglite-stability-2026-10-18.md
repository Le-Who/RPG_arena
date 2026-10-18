# Стабильность V8/PGlite и поддерживаемый Node — 18 октября 2026

## Решение

Проект использует Node.js **22.23.3 LTS**, npm **10.9.9**, V8 **12.4.254.21-node.57**. `.node-version` задаёт точный релиз для разработки и CI, Docker использует `node:22.23.3-bookworm-slim`. `package.json` и корневая запись lockfile допускают `>=22.23.3 <23`; `.npmrc` включает `engine-strict`. Более поздние стабильные maintenance-релизы Node 22 проходят engines, но точный baseline CI/Docker обновляется явно после проверки.

Next **16.4.2**, React **19.2.6**, ESLint **10.13.0**, нативные lint-плагины и все версии lockfile сохранены. Node 22.23.3 удовлетворяет установленным engines Next (`>=20.9.0`) и ESLint (`^20.19.0 || ^22.13.0 || >=24`). Поддержка Node 22 по официальному графику заканчивается **30 апреля 2027**; перед этой датой потребуется проверить следующий поддерживаемый LTS. [Релиз Node](https://nodejs.org/en/blog/release/v22.23.3), [график поддержки](https://github.com/nodejs/Release/blob/main/schedule.json).

## Причина и границы вывода

В предыдущем полном прогоне на Node 24.13.0 был native abort после четырёх checkpoint-проверок: `Check failed: jit_page_->allocations_.erase(addr) == 1`. Это не JS assertion приложения: стек уходит в V8/Wasm освобождение JIT allocation. Повторный зелёный прогон на том же Node не устранял дефект.

Сигнатура совпадает с открытым upstream [nodejs/node#66366](https://github.com/nodejs/node/issues/66366): проблема жизненного цикла Wasm import wrappers исправлена в [V8 9b8ca54d5a](https://github.com/v8/v8/commit/9b8ca54d5a). На дату проверки в исходниках [Node 24.22.0](https://github.com/nodejs/node/blob/v24.22.0/deps/v8/src/wasm/wasm-import-wrapper-cache.cc) остаётся прежний порядок `AddRef()`/`is_dying()`. Совпадение fatal signature и upstream-описания обосновывает выбор другой поддерживаемой ветки; точный локальный native race без symbolized dump отдельно не доказан. [Node 22 использует более старую архитектуру Wasm wrapper cache](https://github.com/nodejs/node/blob/v22.23.3/deps/v8/src/wasm/wasm-import-wrapper-cache.h), предшествующую проблемной реализации.

PGlite остаётся **0.5.8**, pgvector — **0.0.9**. Свежий PGlite 0.5.10 исправляет ожидание pending queries при close, но не заявляет исправление этого native V8 abort; обновление вместе с bundled PostgreSQL требует отдельной проверки. [Changelog PGlite](https://github.com/electric-sql/pglite/blob/main/packages/pglite/CHANGELOG.md). Сам PGlite уже кэширует compiled Wasm modules; кэширование compiled modules само по себе не исправляет upstream race жизненного цикла import wrappers.

Каждая fixture по-прежнему создаёт свежую БД, применяет прежние миграции с pgvector/pgcrypto и ожидает `close()`. Shared DB/reset, постоянная скрытая keepalive-БД, автоматические повторы тестов, отключение Wasm GC и снятие проверок не вводились. Штатные test/coverage scripts и concurrency сохранены.

## Защита от возврата небезопасной среды

`tests/helpers/test-environment.ts` вызывает `assertTestRuntime()` до исполнения тестового файла. Проверка читает реальные `package.json`/`.node-version` и отвергает неподдерживаемый Node с ошибкой `UNSUPPORTED_TEST_NODE`, фактической и нужной версиями и указанием выполнить `npm ci`. Это не пропуск: команда завершается ненулевым кодом. Подставной DATABASE_URL и очистка provider/keyring configuration сохранены.

Шесть новых ordinary-регистраций проверяют принимаемые/отклоняемые версии, prerelease/malformed inputs, реальный запуск preloader в дочернем процессе, недостижимость тела теста при несовместимости, очистку синтетических credentials и engines установленного Next/ESLint. RED до реализации: прежний preloader разрешил выполнение тела при несовместимом fixture engines, exit 0; после изменения интеграционная регрессия и остальные проверки проходят на Node 22.

## Проверка

Проверки выполняются portable Node 22.23.3 из официального Windows x64 ZIP с проверенным SHA256: `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71`. PATH дочерних npm-команд начинается с того же Node/npm. Глобальный Node пользователя не заменяется. Проверочная физическая копия исключает `.env`, реальные БД и provider keys; используются синтетический DSN и PGlite.

Физическая копия содержит 624 repository inputs. Все **526 non-document inputs** в исходном дереве и копии сохранили исходные SHA256 после проверок. Сравнение manifest/lock с началом этапа подтвердило: меняется только root `engines.node`, версии и граф зависимостей, test/coverage scripts неизменны.

| Проверка | Результат |
| --- | --- |
| Clean `npm ci --ignore-scripts --no-fund` | exit 0; установлено 350 пакетов, audit 0 |
| Next route typegen, итоговые typecheck и lint | exit 0 |
| Focused toolchain/bootstrap/worker на чистой копии | 79/79 |
| Runtime policy/bootstrap после исправления fixture | 7/7 |
| Прежний проблемный checkpoint-файл | 44/44 |
| Штатный полный `npm test` | **1217/1217**, fail/cancelled/skipped/todo 0; **одна полная попытка**, 876110 мс по внешнему launcher |
| Сохранность прежнего набора | все 1211 имён и multiplicities сохранены; добавлены ровно 6 runtime-policy registrations |
| PGlite lifecycle stress | **120/120**, четыре свежих процесса по 30 свежих БД; 333251 мс, без retry и GC-флагов |
| Штатный production build | Next 16.4.2 / Turbopack, exit 0 |
| Production HTTP smoke на Node 22 | version/manifest/icon 200, no-store, нет identity cookie, язык ru |
| `npm audit --json` / `--omit=dev` | 0 / 0 уязвимостей |
| `npm ls --all --json` | exit 0, invalid/missing 0; две прежние optional/extraneous записи Sharp WASM и @emnapi/runtime |
| Прямой запуск preloader на исходном Node 24.13.0 | ожидаемый exit 1 с UNSUPPORTED_TEST_NODE; тело теста недостижимо |
| Независимый review конфигурации и guard | PASS; устаревшие указания Node 24 в README/worker guide исправлены |

Каждый stress-цикл проверяет отсутствие marker table предыдущей базы, записывает 256 строк с индивидуальным owner, проверяет vector distance и pgcrypto bytes, ожидает `close()` и проверяет closed state. Это фиксированная нагрузка, а не повтор упавшего теста. Полный набор выполнялся отдельно от сборки и stress.

Первый typecheck обнаружил обязательный `NODE_ENV` из типов Next в новой синтетической subprocess fixture. Добавлен `NODE_ENV: "test"`; affected 7/7, итоговые typecheck/lint и полный набор выполнены уже после этой правки. Во время полного набора код и конфигурация не менялись.

При подготовке коммита `git diff --cached --check` обнаружил лишнюю пустую строку в конце `tooling/braces/lib/stringify.js`. Удалена только эта строка; текст без завершающих whitespace и поток JS-токенов совпадают с прошедшей полный набор копией. Остальные 525 non-document inputs сохранили SHA256. Финальные проверки этой подготовки и доказательство единственной форматной разницы хранятся отдельно в `output/precommit-main-2026-10-18/`; исходные full/stress журналы сохранены.

Артефакты: `output/v8-pglite-stability-2026-10-18/`. Основные файлы: `tests-full.log/json`, `pglite-stress.log/json`, `test-inventory.json`, `contracts.json`, `final-input-comparison.json`, `node-provenance.json`, `acceptance-results.json`. Команда проверки документации — `npm run check:docs`, её финальный журнал — `docs-final.log/json`. Предыдущие журналы Node 24 сохранены отдельно и не подменены новым результатом.

Docker tag проверен через официальный Docker Hub API; Linux image build без доступного Docker CLI не заявляется. Native PostgreSQL service jobs CI и браузерная матрица требуют своих окружений и не считаются выполненными локальным ordinary набором.

## Повторение и обновление baseline

В терминале проекта сначала выберите Node 22.23.3 через используемый менеджер версий или официальный дистрибутив и проверьте `node --version`. Один только checkout `.node-version` не меняет глобальный Node в PowerShell. Затем выполните `npm ci --ignore-scripts`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run check:docs` и `npm run build`. Для typecheck на совершенно свежем checkout предварительно создайте Next route types командой `npx next typegen`, как в CI.

Сценарий приёмочного stress сохранён отдельно: `node output/v8-pglite-stability-2026-10-18/pglite-stress.cjs` из корня с установленными dev dependencies. Его фиксированная нагрузка — четыре процесса по 30 lifecycle; первая ошибка останавливает сценарий. Он не добавляет повторов к обычному `npm test`.

Возвращать допуск Node 24 или переходить на следующий LTS следует после подтверждения upstream/backport исправления и отдельного успешного полного набора со stress на новой версии. Текущий Node 22 baseline остаётся поддерживаемым до указанной выше даты; бессрочная совместимость будущих релизов и отсутствие любых возможных native падений этими проверками не утверждаются.
