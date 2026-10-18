# Совместимость Node 22 с Vercel — 18 октября 2026

## Причина и исправление

После исходной стабилизации V8/PGlite Vercel использовал Node **22.23.2** и npm **10.9.8**, хотя `package.json` требовал `>=22.23.3 <23`. Включённый `engine-strict` корректно остановил установку с EBADENGINE. Ошибка была в слишком высоком проектном floor для управляемой платформой patch-версии.

Минимальная поддерживаемая версия — **22.23.2**, диапазон manifest/корневой записи lockfile — `>=22.23.2 <23`. `.npmrc` сохраняет `engine-strict=true`; `.node-version`, CI и Docker остаются на рекомендуемом **22.23.3**. Node 24, более старые Node 22 и prerelease по-прежнему отвергаются. Версии зависимостей, Next 16.4.2, ESLint 10.13.0, test/coverage scripts и изоляция PGlite не меняются.

Vercel предоставляет выбор major-ветки и сам разворачивает minor/patch. `engines.node` перекрывает Project Settings; `.node-version` не заставляет Vercel поставить конкретный patch. Поэтому расширение floor должно соответствовать реально проверенной совместимости, а не выключать engine checks. Для устранения предупреждения о расхождении настроек в Project Settings следует выбрать **22.x**; сам выбор ветки уже задаёт manifest. [Официальная документация Vercel](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

Node 22.23.2 — security release; 22.23.3 содержит последующие OpenSSL/CA/Undici и другие maintenance-исправления, включая V8 CpuProfiler/GC reentry. Патчи не объявляются идентичными. Оба сохраняют прежнюю архитектуру Wasm wrapper cache, на которой основан уход с проблемного Node 24. Точный рекомендуемый pin 22.23.3 сохраняется. [Релиз 22.23.2](https://nodejs.org/en/blog/release/v22.23.2), [релиз 22.23.3](https://nodejs.org/en/blog/release/v22.23.3), [V8 cherry-pick](https://github.com/nodejs/node/commit/3376e27de2).

## Регрессия и проверка

Добавлена ordinary-регистрация, проверяющая Node 22.23.2 против engines проекта, установленного Next и ESLint, а также реального test runtime guard. До исправления она завершилась intended RED: manifest отклонял Vercel patch. Нижняя отрицательная граница перенесена на 22.23.1; проверки отказа Node 24 и prerelease сохранены.

Приёмка выполняется на официальном portable Node 22.23.2/npm 10.9.8 с проверенным SHA256 ZIP `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`, на физической копии без `.env` и настоящих provider keys/БД. Snapshot включает 625 repository inputs и 526 non-document inputs. Артефакты — `output/vercel-node22-compat-2026-10-18/`.

| Проверка | Результат |
| --- | --- |
| Intended RED нового Vercel-теста на прежнем floor | exit 1: 22.23.2 отклонён проектным engines |
| Runtime policy и очистка окружения на 22.23.2 | 8/8 |
| Runtime policy на рекомендованном 22.23.3 | 7/7 |
| Чистый обычный `npm install`, lifecycle scripts включены | exit 0, 350 пакетов; Node 22.23.2/npm 10.9.8, engine-strict=true |
| Focused toolchain/bootstrap/worker | 80/80 |
| Next route typegen, typecheck, lint | exit 0 |
| Production build | Next 16.4.2/Turbopack, exit 0 |
| Production HTTP smoke | version/manifest/icon 200, no-store, без identity cookie, язык ru |
| Full/runtime npm audit | 0/0 уязвимостей |
| Полный штатный `npm test` на 22.23.2 | **1218/1218**, fail/cancelled/skipped/todo 0, одна попытка; launcher 656028 мс |
| Состав полного набора | все 1217 прежних имён и multiplicities сохранены, добавлена ровно одна Vercel-регрессия |
| PGlite lifecycle stress на 22.23.2 | **120/120**, четыре процесса по 30 свежих БД, 217847 мс; без retry и GC-флагов |
| Сохранность code/config/SQL/public inputs | все **526** сохранили SHA256 в исходном дереве и копии |

Обычный npm 10.9.8 переписал только metadata `peer` (118 entries) и `libc` (38 entries), сохранив все 462 package entries, их version/resolved/integrity и dependency edges. Сгенерированный lock сохранён в `package-lock.npm10-install.json`; сравнение — `install-lock-comparison.json`. Исходный lock с Linux ABI metadata восстановлен в проверочной копии после сравнения, без замены установленных пакетов. В repository lock меняется только root engines; generated metadata не вносится в Git.

Полный npm test и lifecycle stress выполнены последовательно, отдельно от сборки, с обычными проверками и GC. Каждый stress-цикл проверяет отсутствие данных прежней БД, запись 256 строк с собственным owner, vector/pgcrypto и обязательное завершение `close()`. Независимый readonly review узкой правки — PASS.

Сводка и raw evidence: `acceptance-results.json`, `tests-full.log/json`, `pglite-stress.log/json`, `vercel-install.log/json`, `install-lock-comparison.json`, `final-input-comparison.json`, `node-provenance.json`. Финальная проверка локальных ссылок — `npm run check:docs`, журнал `docs-final.log/json`. Отчёты исходного baseline 22.23.3 и предыдущего CI сохранены отдельно.

Локальные проверки не являются запуском Vercel production migration или подтверждением production deployment. Существующий `build:deploy` и его обязательная миграция сохранены; локальная сборка использует `npm run build` и синтетический DSN.
