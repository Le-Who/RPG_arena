# P2 world-graph, клавиатурная карта и WebVitals — 15.10.2026

Этап продолжает [матрицу покрытия](testing/coverage-matrix-2026-10-09.md), строка24, после [1004 ordinary tests](p2-ui-persistence-test-coverage-2026-10-15.md). [План](superpowers/plans/2026-10-15-p2-map-vitals-coverage.md) задаёт порядок: границы графа и клавиатурная карта, затем privacy/lifecycle WebVitals.

Работа выполняется в ранее подключённом isolated worktree. Сохранены574 main preimages и prior1004 LCOV SHA-256 `eb821db6953211e6b760ef35ee9019efd4f8fa4fa9c38f2bd52ca75bc0366aa5`. Сабагенты gpt-6.1-sol: medium для ограниченной graph math, high для browser/lifecycle/review. Все прежние изменения сохраняются; commit/push не запланированы.

## Граф и карта

`tests/world-graph-boundaries-p2.test.ts` добавляет22 runtime registrations: literal danger24/25/49/50, center single/empty/coincident, horizontal/vertical axes, compact two/three versus four-pin geometry, обычные inset/spread, NaN/±Infinity bounds/query и frozen input purity с original object identities. Original new+adjacent run:36total/27pass/9behavioral RED. Root cause — unfiltered Math.min/max и nonfinite query normalization. Минимальный fix фильтрует конечные границы по каждой оси и центрирует invalid axis; обычная finite geometry сохраняется. Final focused и independent fresh36/36 exit0. Supported world coordinates и обычная configuration проверены; весь экстремальный числовой диапазон JavaScript не заявляется покрытым.

`scripts/world-map-keyboard-p2-browser.ts` исполняет actual WorldMap и Dialog в isolated Chromium. Original16/16 GREEN, production компоненты не менялись. Desktop1280×900 и mobile390×844: 36 literal pins, discovery filtering/hidden routes, Tab/ShiftTab trap и traversal каждой точки, Enter/Space exact callback once, focus return, Escape/close button, read-only/empty/hidden-only/single и отсутствие document overflow/page errors. Callback не вызывает server movement. Canvas вписан в диалог; принудительное body-scroll поведение не заявляется проверенным. На dense mobile fixture подписи пересекаются/обрезаются: visual legibility остаётся отдельным наблюдаемым ограничением, keyboard reachability его не доказывает.

## WebVitals

`scripts/web-vitals-lifecycle-p2-browser.ts` выполняет actual WebVitalsReporter и React lifecycle с loopback HTTP receiver. Corrected original baseline15/25 сохранил10 behavioral RED четырёх причин: шесть DNT/GPC queued drains, controlled/native buffered measure replay после remount, invalid vital-ID и resource-slot poisoning. Исходный reporter preimage совпадает с main. Earlier fixture drafts12/25 и navigation draft сохранены отдельно и исключены из product RED: Playwright clock менял Performance API, а async metadata callback не переживал unload.

Минимальные исправления: flush повторно проверяет privacy и удаляет запрещённую очередь; WeakSet принятых PerformanceEntry подавляет buffered replay без удержания объектов и без схлопывания новых equal-time entries; vital/resource dedupe отмечается после успешного finite/nonnegative enqueue. Targeted6/2/2 и полный25/25 GREEN; independent fresh25/25 без findings. Server upper bounds/contract, schema и dependencies не менялись.

Проверены initial DNT/GPC/combined, development suppression, exact safe desktop/mobile payload и document versus SPA route, pagehide/hidden/unmount drain-once и cleanup, timer14999/15000, batch20+remainder, resource observer fallback,503 best-effort без retry, stable callbacks и distinct/new turn entries. Actual navigation получил один safe POST на loopback receiver с keepalive=true, credentials=same-origin и trusted `native-pagehide:true`. Это отдельный сценарий от controlled lifecycle dispatch.

Next hook registration и большая часть observer inputs контролируются фикстурой; production reporter/React effects/module queue/sets/listeners/HTTP настоящие. Отдельный native PerformanceObserver case подтверждает identity/replay для Chromium. Fixture-only sessionStorage синхронно сохраняет fetch init через unload; production reporter storage не использует. Opt-in absence проверяет mount boundary фикстуры; deployed Next layout, BFCache, Firefox/WebKit и репрезентативные field-performance measurements остаются за пределами этого этапа.

## Сводная проверка и доставка

Full ordinary **1026/1026**, fail/cancelled/skipped/todo0, exit0, 637931.8636ms; было1004, добавлено22 registrations в1 ordinary файле. Current LCOV SHA-256 `6aa20ba2295f57e8c90ffdaf0c5e6b34618b02ed20aeb33a3102a151b034ef36`; 176 loaded/52 not-loaded src records — raw V8/tsx transformed subset, не процент всего приложения или исходного TypeScript. AST729 calls и runtime1026 registrations — разные единицы; browser16/25 не прибавляются к ordinary count.

Все447 frozen source/test/script/config inputs неизменны. Typecheck/global lint/default Next16.3.8 Turbopack build exit0. Изолированная owned temporary copy использует прежние physical dependencies после проверки444 предыдущих hashes; .env отсутствуют, safe OS allowlist/fake loopback DB, без provider credentials. Browser coordinator16/25 и независимый review без открытых findings подтверждены отдельными logs. Documentation checker82files/334links exit0, inventory228source/149tests и все8809 structured references проверены; current/history LCOV и runtime log hashes совпадают. Main delivery выполняется после проверки исходных preimages.

Отчёты областей graph-report/map-report/vitals-report, independent review, raw RED/GREEN и manifests сохранены в `output/p2-map-vitals-coverage/`; browser artifacts — в `output/playwright/world-map-keyboard-p2/` и `output/playwright/web-vitals-lifecycle-p2/`. Это local generated evidence.



В main перенесены только 12 файлов этапа после проверки всех 574 исходных preimages. Все 447 source/test/script/config files совпадают побайтно с проверенным freeze; fresh main 22/22 новых ordinary tests, typecheck и lint прошли. Full 1026 и isolated build на идентичных исходниках не дублировались. Main logs, source proof и delivery manifest сохранены рядом. Прежние изменения сохранены; commit/push не выполнялись.
