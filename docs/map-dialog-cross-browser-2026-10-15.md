# Карта и диалоги в Firefox и WebKit — 15–16.10.2026

Этап продолжает [исправление читаемости и доступности карты](dense-map-accessibility-2026-10-15.md). Проверяются actual production WorldMap, Dialog, world-graph и CSS в изолированных React/esbuild fixtures. Карта использует production React bundle; отдельная фикстура общего Dialog — development React StrictMode для проверки повторных effects и cleanup. Использован существующий lockfile и Playwright1.63.0, без изменения npm dependencies. Дополнительно установлены соответствующие pinned browser binaries: Firefox155.0/build1543 и WebKit26.6/build2359; Chromium153.0.8010.12/build1243 служит контролем. Локальная платформа — Windows x64.

## Найденные причины и изменения

**Firefox: неявные остановки Tab.** Прокручиваемые `.dialog-body` и интерактивная `.gx-map-canvas` сами попадали в последовательную клавиатурную навигацию. Их не было в явном наборе контролов focus trap. В минимальном native HTML control Tab достигал overflow div перед вложенной кнопкой; настоящий keyboard baseline воспроизвёл10/16 failures. Явный `tabIndex=-1` исключает эти служебные контейнеры; именованная read-only область карты сохраняет `tabIndex=0` и PageDown/End. Реальный порядок и активация локаций сохраняются.

**WebKit: возврат фокуса после pointer opening.** Trusted click по кнопке оставлял `document.activeElement=BODY`; при вложенном открытии активным оставался родительский Dialog. Это допустимое различие native button behavior, а не ошибка движка; [MDN описывает отсутствие click focus в Safari](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#clicking_and_focus). Ошибка приложения состояла в том, что Dialog принимал activeElement за инициатора и возвращал фокус в body/родителя. Валидный22-case baseline дал6pass/16behavioral RED; Chromium/Firefox22/22 уже работали.

Dialog теперь сохраняет trusted primary-click activation до React mount и использует её для layer/session opener. Per-document Symbol registry содержит только WeakRef и не дублирует listeners при HMR. Клавиатурное действие, новый фокус и новый click сбрасывают прежний origin; disconnected/hidden/inert/disabled trigger не используется. Pointer focus глобально не меняется. Добавлены отдельные keyboard opening и stale click→другой input focus→programmatic opening guards, каждый в desktop/mobile. Они были GREEN до исправления и защищают от нового stale-origin поведения.

**WebKit: полностью скрытая сфокусированная карточка в коротком окне.** При200% root font предел32rem становился1024px при viewport844×390. Native вложенная прокрутка оставляла одну oversized карточку полностью вне видимой области даже после condition polling1500ms. Baseline19/20 воспроизводил этот дефект. Диагностический прогон с единственным CSS intervention `max-height:min(32rem,60dvh)` дал20/20, включая реально увеличенный текст и native pointer checks. Та же граница применяется к компактной карте в production; large view сохраняет прокрутку тела Dialog.

**Firefox: частично скрытая карточка после правильного Tab.** После исключения лишних scrollport stops проявился отдельный дефект: native focus достигал правильного button, но прокрутка оставляла часть обычной помещающейся карточки за краем `.dialog-body`. Candidate20-case run дал18pass/2RED при корректных порядке фокуса и callbacks. После native focus scroll WorldMap выполняет `scrollIntoView({block:"nearest",inline:"nearest",behavior:"instant"})` в следующем animation frame. Guard требует connected button, сохранённый activeElement и `:focus-visible`: отложенная работа не перехватывает уже перемещённый фокус, pointer interaction сохраняет native поведение. Проверка полного button/name bounds сохранена; диагностический Firefox run и прогон production исправления дали20/20.

## Постоянные регрессионные проверки

Три существующие фикстуры поддерживают `--browser=chromium|firefox|webkit --final`; отсутствие выбора сохраняет прежний Chromium режим. Engine artifacts, baseline/final и диагностические interventions разделены. Сохраняются версии, source/script/CSS hashes, start/end source stability и bundle/served CSS hashes. Baseline overwrite отвергается до запуска браузера. Диагностические подмены не разрешены в final mode.

`world-map-dense-a11y-browser.ts`:20 cases —320/390px и desktop, длинные/неразрывные названия, coincident/extreme coordinates, full labels/routes, geometry/clipping, native forward/reverse Tab36, read-only native scrolling, callbacks exactly once, forced colors/reduced motion, enlarged text/spacing и short landscape. Фактический root16→32px и label13→26px проверяются перед получением layout evidence. Каждая из36 mouse/touch activations проверяется также через trusted pointerdown и pointerType. `maxTouchPoints=0` в headless metadata не используется вместо проверки реально полученного touch event.

`world-map-keyboard-p2-browser.ts`:16 cases —36 обычных локаций, Enter/Space, ShiftTab/Tab wrapping, Escape/close, empty/hidden/single/read-only и возврат фокуса. `dialog-inert-a11y-browser.ts`:22 cases — прежние18 layer/inert/StrictMode/nested/suspended/late-child/reopen/paint сценариев и4 новых activation guards. Отдельный независимый probe проверяет одновременные parent suspension + replacement mount/resume, соответствующие реальному settings flow.

Новый CI job `map-dialog-browsers` запускает эти три scripts в матрице Chromium/Firefox/WebKit на Ubuntu, отдельно от PostgreSQL и provider environments. `fail-fast:false` сохраняет результаты остальных движков; screenshots/reports загружаются даже при failure. YAML и точные локальные команды проверены; выполнение этого нового job в GitHub Actions ещё не наблюдалось.

## Достоверность evidence

Подтверждённые product RED отделены от ранних fixture failures: cold navigation budget1500/2500ms, screenshot/locator setup под параллельной нагрузкой и сериализация временного named helper (`__name`). Такие артефакты сохранены и не считаются ошибками продукта. Navigation и screenshot budgets отделены от behavior checks; focus/clipping проверяются condition polling без fixed sleep и без ослабления инвариантов. WebKit откладывал пересчёт descendant rem font до layout: read-only чтение root/name bounds перед `getComputedStyle` устраняет stale13px в фикстуре. Сохранён обязательный actual root16→32/name13→26 guard, без подмены font tokens или ослабления assertions. Globals typography не изменялась.

Chromium проверяет unignored AX tree через CDP; Firefox/WebKit — DOM semantics и actual native inert/focus/pointer/keyboard behavior. DOM `ariaSnapshot` не называется платформенным accessibility tree. [CDP sessions доступны только Chromium](https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session). Ручные NVDA/VoiceOver, системный Safari/iOS и полное app-wide WCAG conformance не заявляются; WebKit engine run не подменяет эти проверки.

## Итоговые gates и доставка

Координатор выполнил все девять точных команд нового CI job на замороженных исходниках, максимум два browser processes одновременно. Все174 executions прошли; каждый report подтверждает start/end source stability, отсутствие preimage/diagnostic interventions и ошибок браузера/неожиданных запросов.

| Движок Playwright на Windows x64 | Плотная карта | Клавиатурная навигация | Общий Dialog | Всего |
| --- | --- | --- | --- | --- |
| Chromium153.0.8010.12/build1243 |20/20|16/16|22/22|58/58|
| Firefox155.0/build1543 |20/20|16/16|22/22|58/58|
| WebKit26.6/build2359 |20/20|16/16|22/22|58/58|

Fresh focused world-graph/discovery32/32, owner/composer18/18 и settings22/22 на Chromium, `npm run typecheck`, `npm run lint` и штатный `npm run build` прошли с exit0. Build использовал сохранённый изолированный physical checkout с прежними dependencies:450 frozen inputs совпали побайтно до и после Next16.3.8 Turbopack build, dependency installation и изменение конфигурации не требовались. Прежние owner/settings artifacts сохранены отдельно от текущих.

Независимый reviewer подтвердил108/108 map/keyboard executions и66/66 Dialog cases, без открытых findings. Его before/after source bracket стабилен; после изменения только расширений persisted artifacts финальные served Dialog bundles побайтно идентичны независимо проверенным. Дополнительные native probes проверили pointer restoration и одновременные suspension/replacement/resume во всех трёх движках. Аудит включает324 trusted pointer events и864 focused-button geometry records; реальные2x text metrics подтверждены во всех enlarged cases.

Evidence в `output/p2-map-cross-browser/`: девять `*Browser-<engine>.result.json`/logs, `<engine>-dense|keyboard|dialog-final.json`, `matrix-result.json`, `freeze-manifest.json`, build/gate logs и независимый `review.md`. Screenshots находятся в `output/playwright/map-cross-browser/<engine>/<scope>/<run>/`. Сохранённый bundle имеет расширение `.js.txt`, preimages — `<original path>.txt`, чтобы vendor bundle и копии исходников не попадали в project lint/typecheck. HTTP fixture по-прежнему отдаёт точные original bytes по `/fixture.js`;72 прежних artifacts переименованы с проверкой SHA и mapping в `artifact-renames.json`, immutable reports не переписаны.

Перед доставкой проверяются582 main preimages,450 source/test/script/config inputs и явный список12 task files. Окончательная проверка основного каталога записывается в `delivery-manifest.json` и `final-verification.json`; подробности доставки добавляются ниже после её выполнения.

Все HTTP fixtures — ephemeral loopback, без `.env`, реальной кампании или provider credentials. Сохранены582 main preimages и предыдущий ordinary1026 LCOV SHA-256 `6aa20ba2295f57e8c90ffdaf0c5e6b34618b02ed20aeb33a3102a151b034ef36`. Browser execution counts не увеличивают ordinary test registrations. Нового full ordinary или native PostgreSQL run этот UI-only этап не заявляет; commit/push не выполнялись.

В основной каталог перенесены только12 файлов этапа после проверки всех582 исходных preimages. Все450 source/test/script/config inputs побайтно совпадают с проверенными исходниками worktree. Fresh main WebKit dense20/20 и Dialog22/22, Firefox keyboard16/16, focused graph/discovery32/32, typecheck и lint прошли; финальный docs/inventory check записан в manifest. Общая матрица174, build и independent review относятся к тем же побайтно идентичным inputs; без повторного full ordinary run. Прежние изменения сохранены; commit/push не выполнялись.
