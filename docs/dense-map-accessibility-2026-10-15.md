# Читаемость плотной карты и доступность — 15.10.2026

Этап закрывает наблюдаемый visual gap из [предыдущего map/vitals отчёта](p2-map-vitals-test-coverage-2026-10-15.md) и строки24 [матрицы покрытия](testing/coverage-matrix-2026-10-09.md). Он меняет отображение карты и общий модальный компонент; сохранённые координаты, discovery, граф связей и серверное действие перехода не меняются.

## Причина и поведение

Исходная карта проецировала независимые absolute pins без учёта ширины соседнего текста. Диагностический Chromium run на390px с36 длинными названиями обнаружил48 пересечений прямоугольников и36 обрезанных подписей. CSS дополнительно ограничивал названия двумя строками. Полные accessible names и успешный Tab traversal не доказывали визуальную читаемость.

`WorldMap` теперь показывает дополнительный номерной SVG-обзор и единственный семантический список локаций в порядке входных данных. Соседние и совпадающие точки объединяются в ячейку обзора; общий номер и «+» связывают её с полными названиями в списке. Это приблизительный обзор географии, а не изменение world coordinates. Названия переносятся, включая длинные строки без пробелов; ellipsis и line-clamp отсутствуют. На широком экране список может занимать несколько колонок, на узком остаётся в обычном потоке. Компактная карта прокручивается по вертикали; у крупной карты прокручивается тело диалога.

У каждой интерактивной локации остаётся одна native button с прежним callback и полным русским именем, опасностью и признаком текущего места. Нет второго набора tab stops на графике. Полные названия пройденных маршрутов видимы также текстом: связь внутри объединённой группы не теряется для зрячего читателя. Скрытые локации и incident/dangling edges по-прежнему исключаются существующим `world-graph`.

## Доступность

Список и его элементы имеют семантику list/listitem. Текущее место отмечено `aria-current="location"` и видимым «Вы здесь»; опасность описана текстом в интерактивном и read-only режимах. Декоративные emoji, SVG и иконки скрыты от accessibility APIs. Доступное имя действия содержит полное видимое название. Минимальная высота кнопки44px, фокус обозначен настоящим outline, включая Windows forced colors. Используются существующие reduced-motion правила проекта.

Read-only карта получает именованную focusable region. Это необходимо для native PageDown/End в крупном диалоге: без отдельной области focus trap оставлял клавиатуру на единственной кнопке «Закрыть», а длинный список не прокручивался. Tab/Shift+Tab сохраняют доступ к области и закрытию; Escape возвращает фокус на opener.

Общий `Dialog` изолирует фон через native `inert`. Один координатор владеет стеком активных слоёв, scroll lock и обработчиками focus/keyboard. Он сохраняет исходные значения inert/overflow, обрабатывает новые body children, вложенные и соседние порталы, suspended/resume, первоначальный child-first mount, удаление нижнего окна и StrictMode replay. Escape и backdrop закрывают только верхний слой. Его backdrop располагается на один z-index выше исходного, чтобы DOM-порядок первоначально вложенных порталов не перекрывал активное окно. После закрытия восстанавливается логичный предыдущий фокус. Поведение проверено относительно [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

## Регрессионные доказательства

Новый `scripts/world-map-dense-a11y-browser.ts` собирает actual production WorldMap/Dialog/CSS через esbuild и выполняет20 Chromium cases. Literal fixtures включают36 мест, длинные кириллические и неразрывные названия, совпавшие координаты, крайние точки и скрытые узлы. Проверяются DOM Range bounds, отсутствие line-clamp/overlap/горизонтального overflow, полные названия и маршруты, размер целей, семантика и настоящее unignored Chromium AX tree через CDP. Playwright `ariaSnapshot` сохраняется как дополнительное DOM-semantic evidence и не подменяет AX tree.

Проверены320×740,390×844,1280×900, sparse/dense/read-only, Tab/Shift+Tab через все36 действий, Enter/Space exact callback once и focus return, native pointer/touch выбор, High Contrast, reduced motion,200% font с text-spacing и короткие landscape844×390/640×320. Очень высокая строка может превышать доступный scrollport. Такой тест требует видимого фокуса и доступности полного текста через прокрутку; целиком видимая строка требуется, когда она помещается в реально доступную область с существующими scroll padding/margins. Глобальная компенсация sticky header104px не отключалась, JavaScript focus-scroll workaround не добавлялся.

Исходные production preimages собирались без подмены логики; финальный `baseline-20-complete-result.json`20/20 RED содержит их SHA-256. Ранние попытки фикстуры с ошибкой сериализации helper и ошибочным clipping по content-height body сохранены отдельно и исключены из product RED. Промежуточная новая реализация выявила ghost scroll от absolute sr-only summary; дополнительный document-height guard воспроизвёл17/20 RED. Возврат position:relative и якоря описания устранил пустую прокрутку. Независимый review также выявил read-only keyboard scroll gap: финальное расширение проверок сначала дало17pass/3RED без именованной области, затем20/20 GREEN с region/tabIndex. Промежуточные результаты не приписываются исходной карте.

Новый `scripts/dialog-inert-a11y-browser.ts` выполняет18 сценариев actual Dialog с development React StrictMode в1280×900 и390×640. Исходный baseline0/18:10 AX background exposure,2 late child isolation и6 competing-layer focus failures. Дополнительный paint/hit-test воспроизвёл2 initial-nested failures до исправления z-index. Проверяются background AX/focus/pointer exclusion, native Tab, top-only Escape, точное восстановление inert/overflow, nested/sibling/suspended/reopen и out-of-order cleanup.

## Итоговая проверка и пределы

Coordinator подтвердил20/20 dense-map,18/18 modal,16/16 существующих keyboard cases,18/18 owner/composer и22 settings checks:94 именованных browser cases/checks, отдельно от32/32 focused ordinary graph/discovery registrations. Read-only ветка прежней keyboard фикстуры дополнена новым доступным region и End/Tab-loop; остальные сценарии сохранены. Все108 native pointer activations в трёх dense inline cases проверили36 точных callbacks по одному на место:72 touch taps и36 mouse clicks.

Typecheck, global lint и штатный Next16.3.8 Turbopack production build завершились exit0 на финальных исходниках. Изолированная owned temporary copy проверила449 frozen source/test/script/config hashes и использовала прежние physical dependencies; environment allowlist, fake loopback DB, без `.env` и установки пакетов. Код и фикстуры не менялись во время этих итоговых gates. Независимый reviewer повторил20 dense/18 modal/16 keyboard, проверил исходники и дополнительные native read-only/landscape probes; открытых actionable scoped findings не осталось.

Доказательства, baseline/final reports, source hashes, независимый `review.md` и manifests находятся в `output/p2-dense-map-a11y/`; screenshots — в `output/playwright/world-map-dense-a11y/`, `dialog-inert-a11y/` и существующих fixture directories. Documentation/inventory validation и побайтная доставка фиксируются в final verification manifest этого этапа.

Проверки изолированы: loopback HTTP, literal synthetic locations/API, без `.env`, provider credentials, рабочих кампаний и платных провайдеров. Это actual React/browser behavior и проверка структуры accessibility tree в Chromium. Ручной NVDA/VoiceOver, Firefox/WebKit, полный Next пользовательский путь и соответствие всего приложения всем WCAG criteria не заявляются.

Прежний full ordinary1026/1026 и его LCOV сохраняются как предыдущий run. Новые browser cases не увеличивают ordinary count; UI-only этап не выдаёт прежний full run за свежий. Native PostgreSQL и production deployment не выполнялись.

В основной каталог перенесены только12 файлов этапа после проверки всех579 исходных preimages. Все449 source/test/script/config files побайтно совпадают с проверенными исходниками worktree. Fresh main dense-map20/20, focused graph/discovery32/32, typecheck и lint прошли; финальный docs/inventory check записан в manifest. Build и остальные browser suites на идентичных исходниках повторно не запускались. Прежние изменения сохранены; commit/push не выполнялись.
