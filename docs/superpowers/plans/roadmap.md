# Chronicle Engine — Roadmap

> Актуальный срез: **production-исправления синхронизации, регионов и пула БД, замеры холодного входа гостя/аккаунта, личный Pollinations для рассказчика/иллюстраций, автоматизация DOC-1f и сверка версии 2.10 на Node 22 / Next 16, 19 октября 2026**.
> Этот файл — единый список текущих статусов и приоритетов. Планы отдельных версий ниже — исторические документы, а не параллельные актуальные roadmap.
> «Реализовано» означает наличие в коде; успешное развёртывание и качество реального AI требуют отдельных проверок. Сроки будущих этапов не назначены.

Подробная декомпозиция по одиннадцати направлениям, зависимости, критерии готовности и рекомендуемая последовательность: [roadmap развития от 20 сентября 2026](../../development-roadmap-2026-09-20.md). Это стратегическое дополнение к реестру статусов, а не утверждённая спецификация всех будущих функций.

Дополнение после выборочной интеграции 2.9: [следующие шаги и приоритет JEV-3](../../development-roadmap-2026-09-27.md). **JEV-3 — универсальное применение Jev для задач проекта — важный приоритет P1 ближайшего цикла.** Общий слой Choice и адаптеры реализованы; следующий шаг — размеченная оценка механик и отдельный допуск наблюдения. [Дополнения поставки и границы](../../revision-29-addendum-review.md).

## Продуктовые решения

### Загрузка пространства и сохранение настроек — 19.10.2026

Исправление поставлено на рабочий сайт; production baseline до/после снят с настоящей БД для гостя и отдельного технического аккаунта. Медиана сохранения 4736→1063 мс и 6034→1050 мс, повторной загрузки данных 2514→1328 мс и 3175→1514 мс. Справка открывается до ответа bootstrap (медианы 654/632 мс). Первый вход гостя сохраняет разброс: 1641–3670 мс после поставки. Новый CI сценарий выявил переполнение строки ключа рассказчика; перенос исправлен и проверен на 320/390/1280 px. [Методика, все точки, небольшие n=5/10, поставка и CI](../../database-latency-production-2026-10-19.md).

**DOC-1f — автоматизированный предрелизный срез выполнен:** push/PR CI проверяет документацию, команды и ledger; unit runner самостоятельно изолирует DB/provider окружение. Внешние URL, heading anchors и смысловая сверка описаний остаются ручными. **PERF-4 — production-срез загрузки пространства выполнен:** браузерный before/after дополнен измерениями соединений/очереди, переносом функций из `iad1` в `fra1` рядом с Neon и проверками после фактического `SUSPENDED`. Первая загрузка в повторной серии: медианы 1743→880 мс (гость), 1740→890 мс (аккаунт); сохранение 1144→229 / 1031→223 мс. Холодные пары после приостановки БД: 4182→2651 / 4276→2649 мс. [Точки, методика, ограничения малых выборок и проверки](../../database-cold-entry-production-2026-10-19.md). Независимый platform init/span и устойчивый cold p95 под нагрузкой не заявляются. DS-1 с визуальными эталонами/контрастом, PERF-1 с длинными историями/INP и PERF-2 с реальным AI-ходом не закрыты.

Итоговый CI `3f25fbc` — success: 1232 unit, 38 native PostgreSQL, 174 map/dialog executions трёх браузеров, 44 workspace/settings/draft checks, fresh/replay migrations, build, actual-handler retry и two-build PWA rollout. Итоговые документы проверены отдельно; исходные точки и ссылки CI приведены в отчёте выше.

Начальная загрузка и refresh сведены к одному owner-bound `/api/bootstrap` с последней проверкой identity. Сохранение обычной настройки использует канонический результат одного POST; повторное чтение настроек и полная перезагрузка пространства убраны из этого пути. Общий допуск владельца и разрешение аккаунта сокращают SQL roundtrips без кэша авторизации. Публичная оболочка открывается без доступной БД; API и административные страницы сохраняют проверки. Добавлены регрессии гонок профиля, отзыва сессии и черновиков, а также метрика `API_BOOTSTRAP`. [Причины, изменения, проверки и границы](../../database-synchronization-latency-2026-10-19.md). Прежние task IDs сохранены.

### Личное подключение Pollinations и иллюстрации — 19.10.2026

Проверен и поставлен на рабочий сайт подготовленный срез NARR-11 / VIS-1/2: штатный OAuth через публичный HTTPS client metadata, каталоги текста/изображений с разрешениями ключа, явный выбор аккаунта оплаты и личной модели. Миграция `0020` сохраняет источник каждой иллюстрации; повторы не меняют плательщика. Проверка готовности закрыла дедлайны OAuth, возврат при отмене/ошибке, окончательные identity fences, лишние SQL, потерю новой правки при общем сохранении и переполнение на 320 px. [Контракт](../../text-providers-operations.md), [проверки и поставка](../../pollinations-personal-account-release-2026-10-19.md). Production-проверка гостя/аккаунта подтвердила каталоги, старт OAuth, изоляцию и сохранение; медианы обычного сохранения 223/211 мс (n=5). Живой consent, расход Pollen и качество генерации не подтверждены; VIS-0 и назначение модели отдельной кампании остаются открытыми.

### Актуальность описаний и индикации — 19.10.2026

Версия продукта, дата сверки и краткое описание сведены в общие метаданные. «Пульс движка», «О движке», окно обновлений, PWA manifest и тестовые fixtures используют их; документационный checker замечает рассогласование текущих версии/даты README. Диагностика отдельно объясняет готовность внешнего рассказчика и Gemini-эмбеддингов, а отсутствие свежего heartbeat не объявляется доказанной остановкой worker. Уточнены ограничения аккаунтов, маршрутизация Gemini, тестовая среда и действующие инструкции развёртывания. Исторические версии и прежние task IDs сохранены. [Область сверки, исправления и проверки](../../current-copy-audit-2026-10-19.md).

### Node 22 на управляемом Vercel runtime — 18.10.2026

Installation/runtime floor скорректирован до `>=22.23.2 <23`: Vercel выбирает major 22, но предоставляет patch 22.23.2/npm10.9.8. Прежний floor 22.23.3 вместе с engine-strict приводил к EBADENGINE. Strict проверка сохранена, рекомендованный dev/CI/Docker pin остаётся 22.23.3; добавлена регрессия реального Vercel patch. [Причина и результаты приёмки](../../vercel-node22-compatibility-2026-10-18.md). Прежние task IDs сохранены.

На реальном 22.23.2/npm10.9.8 прошли обычный clean npm install с lifecycle scripts, focused80/80, итоговые type/lint/Next build/HTTP smoke, полный ordinary **1218/1218 с первой попытки** и stress **120/120**. Fail/cancelled/skipped/todo 0, full/runtime audit 0, все 526 non-document inputs сохранили SHA256. На pin22.23.3 policy7/7. Версии и dependency edges не менялись; служебная перезапись npm10 peer/libc metadata сохранена в evidence и не внесена в repository lock.

### Стабильность V8/PGlite на поддерживаемом Node — 18.10.2026

Выбран Node 22.23.3 LTS для разработки, CI и Docker; engines ограничен проверенной веткой, установка и test preloader отвергают неподдерживаемый Node. Сигнатура прежнего fatal abort совпадает с открытой upstream-проблемой V8/Wasm в Node 24. Изоляция PGlite, миграции, Next 16.4.2 и нативный ESLint 10 сохранены. Добавлено шесть runtime-проверок.

Штатный полный ordinary **1217/1217 с первой попытки**, fail/cancelled/skipped/todo 0; все 1211 прежних регистраций сохранены. Stress **120/120** свежих PGlite lifecycle в четырёх процессах прошёл с обычным GC. Clean install, focused79/79, checkpoint44/44, итоговые type/lint, production build и HTTP smoke — exit 0; full/runtime audit 0, все 526 non-document inputs сохранили SHA256. Независимый review — PASS. Node 22 поддерживается до 30 апреля 2027; переход на следующий LTS требует подтверждённого upstream исправления и проверки нового baseline. [Причина, решение и результаты приёмки](../../v8-pglite-stability-2026-10-18.md). Предыдущие task IDs сохраняются.

### Нативные ESLint 10 плагины после аудита React — 18.10.2026

В 46 TSX-файлах приложения нет классовых React-компонентов или старых API. Legacy классовые blockers сняты; TypeScript проверяет duplicate props/JSX names, core guards удерживают JSX в TSX и исключают классы в TSX. Сохранены все 22 Next и 16 hooks правил, шесть a11y warnings и современные children/key/display-name проверки. Кавычки и апострофы разрешены как корректный JSX-текст; TSX default exports требуют именованных bindings. Compat, старые React/a11y/import плагины, eslint-config-next и eslint peer override удалены; отдельный braces security patch сохранён.

Final focused 70/70, checkpoint repeat 44/44 и полный штатный ordinary **1211/1211** прошли, fail/cancelled/skipped/todo 0. Все 1141 прикладных и 40 security/glob executions сохранены по сверке имён; 47 старых toolchain registrations заменены 30 актуальными. Первый полный запуск получил native V8/WASM abort; повтор прошёл на том же Node без изменений исходников/GC flags. Clean-install/type/lint/build/production HTTP и audit gates прошли; full/runtime audit 0. Сохранены hashes 522 non-document inputs; итоговый npm ls exit 0 при двух optional/extraneous Sharp/WASM записях и отсутствии invalid/missing. [Решение, границы и результаты](../../react-eslint-native-policy-2026-10-18.md). Прежние task IDs сохранены.

### Проверка нативных ESLint 10 плагинов — 18.10.2026

Кандидаты React5.28.1, JSX a11y-x0.2.0 и import-x4.17.1 проверены в отдельной чистой npm-установке без overrides. Полный переход отложен: 14 React JSX/TSX fixtures теряют действующие диагностики, хотя положительный контроль обычного state assignment работает. A11y24/import22 и import-order fix совпали на проверенном срезе. Частичный переход оставляет React bridge/peer exception и добавляет сопровождение конфигурации; текущие package/config/lock сохранены побайтово.

Добавлено8 ordinary registrations; focused87/87, независимые47/47 и полный ordinary **1228/1228** прошли, fail/cancelled/skipped/todo0. Clean-install/tree/type/lint/default build и production HTTP smoke прошли; full/runtime audit0. Все522 non-document inputs сохранили hashes. [Кандидаты, решение и доказательства](../../native-eslint-plugins-evaluation-2026-10-18.md), [план](2026-10-18-native-eslint-plugins.md). Предыдущие task IDs сохранены.

### Поддерживаемый ESLint 10 и Next 16.4 — 18.10.2026

ESLint обновлён до 10.13.0, согласованный Next/config/plugin — до 16.4.2. Официальный compat 2.1.1 дополняет upstream Next bridge для React/import SourceCode API; текущие React/JSX a11y/import peer-ограничения обозначены явно. Все 67 записей правил (62 активных), параметры, globals и ignores сохранены. Две общие root overrides устраняют конфликт наследования npm 11; постоянный guard проверяет сырые peer-контракты и braces API, сам depth-патч сохранён.

Добавлено39 ordinary registrations, final focused84/84, штатный полный ordinary **1220/1220**, fail/cancelled/skipped/todo0. Clean-install/tree/full-runtime-audit/type/lint/default Turbopack build и production HTTP smoke прошли; audit0. Независимый review закрыл потерю Linux SWC ABI metadata и подтвердил адаптацию OAuth fixture к `stagedFallbackParams`; открытых findings нет. Зафиксированы522 non-document inputs. [Решение, ограничения поддержки и доказательства](../../eslint10-migration-2026-10-18.md), [план](2026-10-18-eslint10-migration.md). Предыдущие task IDs и продуктовые режимы сохранены.

### Исправление ESLint high-цепочки с сохранением Next 16 — 18.10.2026

Сохранён стек Next/config/plugin16.3.8. Приватный локальный braces patch ограничивает parser/compile/expand/stringify depth и подключён только к установленной lint-цепочке. Полноценная грамматика, numeric ranges, symlink/junction и root scope сохраняются; engine aliases отклонены после независимого review. Focused40/40, полный последовательный ordinary1181/1181, clean-install/type/lint/build/docs gates прошли. Full/runtime npm audit0; 521 non-document inputs совпадают с проверочной копией. Минимальные Docker install/prune inputs проверены; image build без доступного Docker CLI не заявляется. [Причина, патч, доказательства и условие удаления](../../eslint-dependency-remediation-2026-10-18.md).

### Legacy-аудит, batch-состояние и дедлайны — 18.10.2026

Удалены неиспользуемый алгоритм карты, остаточный Drizzle Kit config, восемь dead exports, provider reexport и 48 CSS selector rules. `dotenv` удалён; прямое объявление baseline mapping убрано, Playwright перенесён в dev с сохранением версии. Старые checkpoints/import/settings, миграции, rolling-deploy memory search и отдельный JEV-3b evaluator сохранены по подтверждённым контрактам. [Область, решения и доказательства](../../legacy-cleanup-audit-2026-10-18.md).

Исправлены последовательные quest/NPC/object изменения, общий лимит отношений за ход и финальная NPC semantic memory; отклоняются ложные повторные new-key claims и object-valued memory coercions. Provider fetch/body/telemetry deadlines и cleanup получили регрессии. Первый полный прогон воспроизвёл GC-зависимое зависание evaluation CLI; общий reader закрыл тот же шаблон в пяти скриптах, сохранив бюджеты и auth/report contracts. StoryRecords keyboard search/Reset race исправлены. Добавлено31 ordinary registrations, семь obsolete-map registrations удалены; browser checks учитываются отдельно.

Повторный полный ordinary набор **1141/1141**, fail/cancelled/skipped/todo0. Итоговые typecheck/lint и штатный Turbopack build прошли на чистой установке и побайтово равной копии;505 executable/config/SQL/public inputs неизменны. Независимые заключительные core39/embeddings14/GC15 и Chromium records8/map16 прошли без открытых scoped findings. Runtime npm audit0; пять зафиксированных тогда dev lint findings и последующий переход на ESLint10 закрыты отдельными этапами выше. Live качество моделей, native PostgreSQL contention и production deployment этим этапом не заявляются; прежние task IDs сохранены.

### Границы снимков, передачи предметов и ротации ключей — 18.10.2026

Добавлено85 ordinary registrations:44 для actual checkpoint services,29 для receiver/holding identity и12 для SQL/AES-GCM rotation recovery. Исправлены воспроизведённые обходы persisted row caps, небезопасные traversals и коллизии global snapshot IDs; передача теперь выбирает единственного получателя по stable key/ID перед именем/prose и отвергает missing NPC. Неоднозначная name-only acquisition сохраняет известные holdings и ownership memory. Ротация уже корректна: новые CAS/null/deletion/batch/late-failure/recovery проверки прошли без изменения production. [Контракты, RED/GREEN и пределы](../../persistence-identity-test-coverage-2026-10-18.md), [план](2026-10-18-persistence-identity-coverage.md).

Full ordinary **1117/1117**, fail/cancelled/skipped/todo0; сохранены все1032 исходных имени, добавлено85. Прежний1026 имеет отдельную историю: шесть ранее добавленных JSON/Jev cases не засчитаны в85 новых. Focused44/29/12, adjacent52/83, independent73+12 и typecheck/lint прошли. Зафиксированы494 source/test/script/config/SQL/public inputs; default Turbopack build на побайтово равной физической копии прошёл, включая сверку публичной `.gitignore` конфигурации. Documentation checker86 files/355 links прошёл. Strict portable parsing, старый v1 и singleton remote/courier returns сохраняются. Native COMMIT/crash/disconnect, исчерпывающие malformed scalar fields и независимая live semantic evaluation остаются отдельными boundaries; прежние task IDs сохранены.

### Карта и диалоги в Firefox/WebKit — 15–16.10.2026

Исправлены четыре воспроизведённые причины: Firefox implicit scrollport Tab stops и частично скрытые focused cards, WebKit pointer opener и выход увеличенного inline scrollport за короткий viewport. Read-only native scrolling, Enter/Space, Escape, nested/suspended/inert lifecycle и русские accessible names сохраняются. [Причины, регрессии и границы доказательств](../../map-dialog-cross-browser-2026-10-15.md).

Итоговые174/174 executions прошли:20 dense,16 keyboard и22 Dialog cases на каждом из Chromium/Firefox/WebKit; четыре новых activation guards дополняют прежние18 Dialog cases. Owner18/settings22, focused graph/discovery32, type/lint/docs и штатный isolated Turbopack build также прошли. Заморожены450 code/test/script/config inputs. Добавлена отдельная Ubuntu CI matrix без БД и provider environments; её точные команды проверены локально. Локальный engine run на Windows не заменяет ручные NVDA/VoiceOver, системный Safari/iOS, hosted Linux CI или app-wide WCAG conformance. Ordinary1026 остаётся предыдущим full run; browser executions учитываются отдельно. Independent review и доставка фиксируются в отчёте и inventory; прежние task IDs сохранены.

### Читаемость плотной карты и a11y — 15.10.2026

Номерной обзор с группировкой соседних точек и единственный список полных названий устраняют absolute-label overlap и line-clamp. Видимые маршруты, current/danger/read-only semantics, native keyboard/touch targets и forced-colors outline сохранены или дополнены. Общий Dialog изолирует фон через inert с поддержкой nested/suspended/StrictMode lifecycle; read-only карта получает именованную область для клавиатурной прокрутки. [Регрессионные проверки и пределы](../../dense-map-accessibility-2026-10-15.md).

Итоговые20 map и18 modal cases, существующие16 keyboard/18 owner/22 settings, focused graph/discovery32, typecheck/lint и штатный isolated Turbopack build прошли. Независимый review повторил20/18/16 и не оставил открытых scoped findings;449 code/test/script/config files проверены по hashes. Предыдущий ordinary1026 остаётся отдельным run; browser evidence не прибавляется к ordinary count. Ручной screen reader, cross-browser и app-wide WCAG conformance остаются отдельными проверками; прежние task IDs сохранены.

### P2 world-graph, клавиатурная карта и WebVitals — 15.10.2026

Добавлено22 ordinary registrations для current graph: thresholds/finite geometry/NaN/empty/single/purity, genuine9RED исправлены независимыми конечными bounds и center fallback. Actual WorldMap/Dialog16 desktop/mobile keyboard cases originalGREEN, компоненты без изменений. Actual WebVitals25 privacy/lifecycle cases и отдельные genuine RED/fixes описаны в [отчёте](../../p2-map-vitals-test-coverage-2026-10-15.md); [план](2026-10-15-p2-map-vitals-coverage.md).

Full ordinary **1026/1026**, type/lint/docs/default isolated Turbopack build прошли; independent graph36/map16/vitals25 без открытых findings. Freeze447files, historical LCOV сохранены; доставка фиксируется в отчёте. Dense mobile map label overlap/truncation остаётся наблюдаемым visual gap; keyboard coverage не establishes visual legibility. Vitals fixtures не field-performance или full Next deployment measurement. Independent semantic/live evaluation и прежние task IDs сохранены.

### P2 settings, UI и populated legacy migrations — 15.10.2026

Добавлено7 ordinary registrations: actual provider POST→GET5 и populated pre0000 journal upgrade/replay/rollback2 — original GREEN без изменений handlers/schema/journal. Actual React Chromium: settings22 named checks и PlayRoom18 desktop/mobile cases. Genuine stale-response RED исправлен сохранением нового draft/key и запретом преждевременного save-and-close; social/commitment/arc focus6RED исправлены,8 delayed controls сохраняют намеренно перемещённый фокус. Keyboard item retain/remove4 исходно GREEN. [Контракты, raw evidence и пределы](../../p2-ui-persistence-test-coverage-2026-10-15.md), [план](2026-10-15-p2-ui-persistence-coverage.md).

Full ordinary **1004/1004**, type/lint/docs и штатный isolated Turbopack build прошли; independent review10node/22settings/18owner без открытых findings. Freeze444files; доставка записывается в отчёт. Browser synthetic APIs не доказывают accepted turn, owner SQL или Next hydration; PGlite supported legacy shape не native deployment readiness. Следующие named local P2: current world-graph thresholds/coordinates/keyboard и WebVitals privacy/lifecycle; independent semantic/live evaluation остаётся отдельным scope. Прежние task IDs сохранены.

### P2 batches, social evidence и providers — 15.10.2026

Добавлено86runtime registrations для строк4/7/20: parser/reducer24, social/time/persisted verdict47, provider/cache15. Исправлены воспроизведённые numeric coercion exceptions, recurring overnight day1 overlap и external SSE newline/callback error boundaries. Sequential inventory semantics и quantity default1 сохранены. Public catalog уже корректен: pending/clone/provider/TTL/failure/recovery получили tests без production изменения. [Контракты, genuine RED и пределы](../../p2-boundary-test-coverage-2026-10-15.md), [план](2026-10-15-p2-boundary-test-coverage.md).

Full ordinary **997/997**, type/lint/docs и штатный isolated Turbopack build прошли. Independent review86/86 без открытых findings; source freeze440files, runtime/type corrections завершены до него. Доставка фиксируется в отчёте. Quote provenance и authored verifier refusal остаются разными доказательствами; semantic entailment/live quality не объявляются решёнными. Остальные settings/UI/map/reporter/legacy migration/evaluation P2 и прежние task IDs сохраняются. Схема, миграции и зависимости не менялись.

### P2 ресурсы, transfers/intent и таймеры — 15.10.2026

Добавлено 58 runtime registrations в трёх ordinary файлах для строк 3/5/6 матрицы. Literal HP/XP/DC/risk и failure rewards уже работали корректно. Genuine RED воспроизвёл claim-передачу последнего предмета, ошибочное лекарственное/пациентское основание и неограниченное чтение таймеров; transfer gate теперь требует act, а лекарственный гейт получает transient resolved consume identity и сохраняет patient boundary. Timer parser согласован с существующими portable bounds; midnight refresh/exact expiry/orphan и supported give/partial/full return получили проверки. [Контракт, доказательства и пределы](../../p2-state-test-coverage-2026-10-15.md), [план](2026-10-15-p2-state-test-coverage.md).

Full ordinary **911/911**, type/lint/docs и штатный isolated Turbopack production build прошли. Независимое review:96/96 focused, без открытых замечаний. Type-only fixture correction имеет одинаковый transpiled JS и fresh8/8/typecheck; исходный production стабилен на всём full run. Доставка фиксируется в связанном отчёте. Существующие proposed commitments и XP за провал сохранены; SQL-схема, миграции и portable allowlist не менялись. Ограниченная русская эвристика не является семантическим доказательством; single-holder return не закрывает same-name multi-holder ambiguity. Оставшиеся P2 batch/social/provider/UI/map/legacy migration/evaluation и прежние task IDs сохраняются.

### P2 checkpoints/forks, поиск памяти и evidence —11.10.2026

Проверены названные локальные P2 строки9/14/16. Исправлен завышенный source.end договора; усилена внутренняя runtime verifier envelope граница, а legacy поиск получил тот же UUID tie order, что SQL. Checkpoint production не менялся: новые actual-service/PGlite tests подтверждают cap/conflicts/delete/rollback. Добавлено29runtime registrations в3ordinary файлах; девять mutation controls восстановлены побайтно. [Контракты, genuine RED и пределы](../../p2-persistence-memory-evidence-2026-10-11.md), [план](2026-10-11-p2-persistence-memory-evidence.md).

Full ordinary **853/853**, type/lint/docs и isolated production build прошли; независимое review не нашло новых production defects. После type-only fixture correction affected9/9/typecheck прошли и transpiled output идентичен. Подлинная цитата доказывает источник; authored semantic verdict проверяет propagation. Jev snapshotVersion остаётся localmetadata, replay проверяет body binding; новый wire protocol не вводится. PGlite не native contention/readiness; предыдущие native38 остаются историческим10.10 evidence. Остальные P2 арифметики/transfers/timers/social/providers/UI/maps/legacy migrations/evaluation и существующие task IDs сохраняются.

### Остальные названные P1 — 10.10.2026

После auth проверены реальные память/compaction/queue/telemetry/HTTP/browser/image/process/PWA boundaries. Исправлены accepted narrator outbox mismatch, delayed OAuth/body/catalogue authorization, import retry cleanup, equal-turn overwrite, distributed image duplication и unhandled PG events. Correct existing contracts получили tests+negative controls. Full ordinary **824/824**,10-fixture native **38/38 без skip**, type/lint/docs, actual browser/native retry и2production Next/PWA builds прошли; source equality и independent review сохранены. [Контракты, genuine RED, source restoration и limits](../../p1-continuation-2026-10-10.md).

Подготовлен12-case AI-reviewed temporal corpus с blind annotation и group-heldout6/6; это не human gold/live-model score. Named P1 gaps матрицы закрыты в своих scopes; public deployment/cluster failover/native vector/full replay, live semantic evaluation и measurement limits не превращены в production-readiness claim. Существующие MEM/NARR/SEC/ECO/UX/PERF IDs сохраняются.

### Гонки смены пароля и claim — 10.10.2026

Проверен identity P1 на независимых PostgreSQL соединениях. Исправлены два воспроизведённых дефекта: обычный logout теперь сериализован с защищённым claim через account lock; expiry использует текущее время БД вместо времени BEGIN. Old-hash guard уже работал, новый native-тест доказывает отказ устаревшего входа и успешный вход по новому паролю. Revocation-first и authorized-claim-first имеют отдельные controls; гостевой владелец/settings/consumed mapping не меняются при отказе. Ordinary **757/757**, aggregate пяти native fixtures **17/17 без skip**, build/type/lint/docs и независимое review прошли. [Контракт, RED/повторные проверки и пределы](../../auth-races-2026-10-10.md). Relational19/20 не заменяет pgvector/full replay; остальные P1 и существующие MEM/NARR/SEC/ECO/UX/PERF task IDs сохраняются.

### Защита текущей локации —10.10.2026

Закрыт оставшийся direct-executor риск: чужой/отсутствующий UUID больше не снимает current flags кампании. Один scoped UPDATE с aliased EXISTS меняет карту только при local target; discovery других мест сохраняется. Три регрессии имеют intended RED→GREEN; focused19 и full **756/756** прошли, isolated production build/type/lint/docs —exit0, review —PASS. [Контракт, доказательства и пределы](../../location-current-fix-2026-10-10.md). Native8 предыдущего этапа остаётся историческим09.10 evidence; concurrency при удалении карты этим этапом не проверена. Существующие MEM/NARR/SEC/ECO/UX/PERF task IDs и остальные P1 сохраняются.

### Приоритетное расширение покрытия P1 — 09.10.2026

Добавлены actual route authority60 и map SQL/consumer6 scenarios; ordinary suite **753/753**. Новый native full-turn fixture проверяет six-way contention, replacement/expired lease, independent commit lock и completion rollback всех canonical/outbox writes; aggregate с existing auth/quota/portable — **8/8 без skip**. Exact durable replay получил независимый oracle и corruption control. В CI добавлен opt-in turn gate. [Результаты и границы](../../test-priority-coverage-2026-10-09.md).

Исправлен timestamp parser общего PGlite test adapter, production приложение и исторические миграции не изменены. Это закрывает конкретные gaps1/4 и scoped route matrix12; native pgvector/full replay, identity password races, mixed-owner fairness, browser retry и two-build PWA остаются P1. Существующие MEM/NARR/SEC/ECO/UX/PERF IDs сохраняются.

### Дополнение к аудиту — 09.10.2026

Удалён неиспользуемый Drizzle Kit и явно объявлен bundler browser fixtures, сокращая dev audit 9→5 high entries; runtime audit0. CLI evaluator получил восемь actual subprocess cases, production script остался неизменным. На отдельном portable PostgreSQL16.15 прошли existing auth/quota/portable fixtures без skip, а полный ordinary suite — **687/687**. [Проверки, происхождение runtime и пределы](../../test-followup-2026-10-09.md). Это закрывает исполнение названных native/CLI сценариев; исключение migration0006 в relational fixtures не заменяет pgvector readiness и full-turn/worker concurrency. Остальные MEM/NARR/SEC/ECO/UX/PERF task IDs и приоритеты сохраняются.

### Аудит кодовой базы и тестов — 09.10.2026

Изучена активная кодовая база; сохранены [пофайловая карта и схема покрытия 25 направлений](../../test-coverage-audit-2026-10-09.md). Исправлены воспроизведённые дефекты финального состояния guard/repair, reducers и ссылок на предметы, Unicode-фильтра памяти, provider deadlines/usage/errors, disabled visual retry, нулевых квот и executable evaluator. Importer проверяется через production transaction; UI fixtures требуют явного поведения сохранения и повторов.

Проверено **679/679** обычных unit/integration cases; typecheck, lint и production build прошли. Actual Next build/start/restart подтвердил единый ID artifact/HTML/client/API/SW; current story/turn и standalone gallery/update-guards Chromium прошли. Native PostgreSQL auth/quota проверки включены в уже существующий disposable CI service, локально не выполнены без skip. Synthetic verdicts, PGlite и mock browser checks сохраняют собственные пределы доказательности. Live качество моделей, public deployment и concurrency между процессами не объявлены завершёнными; существующие MEM/NARR/SEC/ECO/UX/PERF task IDs и приоритеты сохраняются. Concrete gaps и подходящие test boundaries перечислены в [матрице](../../testing/coverage-matrix-2026-10-09.md).

### Проверка открытых PR — 02.10.2026

Рассмотрены все 11 PR: девять полезных предложений адаптированы и объединены, два дублирующих заменены уже реализованными или перенесёнными изменениями. [Матрица решений и фактические проверки](../../pr-review-2026-10-02.md).

- **VIS-1/2:** постоянный журнал квоты (`0019`) сохраняет расходы после удаления иллюстраций/кампаний и переноса гостевых историй в аккаунт.
- **ECO-1 / SEC-1:** импорт требует аккаунта и ограничен квотами; неблокирующий допуск и постоянные requestId сохраняют атомарность и отказ после удаления. Защищённые auth-действия используют лимиты проверенного аккаунта; общий анонимный лимит и требование доверенного ingress сохранены.
- **UX / PERF:** адаптированы кеши карты, фильтров и подсказок; сохранены черновик, клавиатурное управление и привязки предметов. Это не измеренный результат INP. Мемоизация ленты уже была реализована в 2.9.
- **SEC-1:** глобальные HTTP-заголовки сохраняют более строгий no-referrer OAuth callback. Эти исправления не закрывают публичный deployment, нагрузочные проверки и внешний аудит.

### Уточнение и интеграция revisions — 23–24.09.2026

Завершена локальная выборочная интеграция четырёх поставок: [отчёт сравнения](../../revision-integration-review-2026-09-23.md), [согласованный дизайн](../specs/2026-09-23-revisions-consolidation-design.md), [план исполнения](2026-09-23-revisions-consolidation.md). Две Astra-поставки идентичны. Это не заявление о внешнем выпуске v2.6 или готовности публичного сервиса.

- **Необязательные аккаунты:** гость сохраняет возможность играть и вести свои кампании. При регистрации они закрепляются за аккаунтом; после выхода — новое гостевое пространство. При входе в существующий аккаунт новые гостевые кампании переносятся только с подтверждением.
- **Административные границы:** «Пульс движка», техническая диагностика и экспериментальные developer/Jev-инструменты закрыты серверной ролью. Личная память, журнал, BYOK-настройки и экспорт остаются доступны гостям и обычным аккаунтам. Роль администратора не отменяет ownership.
- **Реализовано в интеграции:** единое шифрование, безопасные аккаунты, резерв квот до вызовов, переносимый JSON, улучшения интерфейса, readiness/worker/deployment и актуальная справка `/blueprint`. Детали адаптации, проверки и ограничения отражены в отчёте.
- **Проверено до переноса:** 274/274 исходных теста, typecheck и lint. Папки revisions исключены из обхода приложения; реальные миграции/секреты/платные AI-вызовы не затронуты.
- **После этого этапа:** справедливость очередей по владельцам, отдельные пулы extraction/embedding, контролируемый backfill и long-campaign evaluation. ANN, PQ/ADC и замена vector backend — только после измерений; автоматический платный backfill без согласия владельца не вводится.

Проверка 23.09 была расширена аудитом ревизии 2.7: [матрица решений и ограничения](../../revision-2.7-integration-review-2026-09-24.md), [world-life и визуализация](../../world-life-and-visuals.md). Свежий локальный результат на 26.09: **408/408 тестов**, typecheck, lint, build и `check:docs` прошли; build запускался с фиктивным loopback `DATABASE_URL`. Публичный каталог Pollinations прочитан без генерации; production deploy, browser/a11y аудит новой вкладки и независимый security-аудит не заявляются.

Дополнение 26.09: раннее применение настроек чтения из локального кэша убирает ожидание БД для темы первого экрана; серверная запись остаётся источником истины ([контракт](../../reading-preferences-performance.md)). Администратор может выбрать модель **изображений** из каталога Pollinations на `/system/visuals`; выбор для новых иллюстраций хранится в миграции `0015`, а ключ провайдера остаётся серверным. Для окружений без системного pgvector добавлена [инструкция агентам](../../agent-pgvector-setup.md). Новые задачи `NARR-11`, `INTERACT-4`, `PERF-4` детализированы в [roadmap развития](../../development-roadmap-2026-09-20.md).

### Доступность управления и черновик действия — 27.09.2026

Дополнение UX-3 / INTERACT-4: аккаунт и настройки закреплены сверху левого меню, «Голос рассказчика» поднят в начало «Жизни», многострочные списки получили явные подписи. Контекстные фразы дополняют черновик; автоподсказки берут сущности из текущей кампании и сохраняют существующую ID-привязку предметов. Для остальных типов остаётся серверное сопоставление названий, не универсальный протокол ссылок. [Поведение и проверка](../../story-experience-operations.md).

Дополнение UX-3 от 29.09: игровые тексты очищены от повторяющихся технических и рекламных блоков. Детали моделей и хранения остаются в настройках/справке; последствия, происхождение записей, ограничения режима, безопасный повтор и предупреждение о передаче описаний для иллюстраций сохранены. Пользовательская справка и окно обновлений актуализированы до 2.10. [Контракт текстов и браузерная проверка](../../story-experience-operations.md).

### Этап 2.10 — две поставки, 29.09.2026

Выборочно интегрированы opus-high и opus-max: финальные ресурсы «до → после», прежние состояния целей, атомарная ротация владельцев фоновой очереди, переход «ход N», каталог `/design`, статическая PWA-оболочка, явное управление договорённостями и инструменты измерения производительности/промпта. [Матрица решений и проверки](../../revision-2.10-integration-review-2026-09-29.md), [измерительные контракты](../../performance-observability.md).

**Границы:** автоматическое подтверждение участия по имени/локации, приватная CacheStorage-полка и неявное доверие proxy headers не перенесены. Телеметрия включается оператором; фактическое ускорение и качество AI не заявляются. Миграции 0017/0018 добавлены без изменения исторических.

Дополнение ECO-1: [добровольное обновление открытых вкладок](../../app-updates.md). Версия приложения проверяется независимо от SW; перезагрузка сохраняет черновик и привязки предметов, блокируется при незавершённом ходе и открытых формах. Каждая сборка обновляет публичную оболочку, а ограниченный общий кэш сохраняет уже загруженные старые чанки. Автоперезагрузка, приватный офлайн-кэш и обещание бессрочной совместимости старых вкладок не вводятся. [План и проверка](2026-09-29-safe-app-updates.md).

### Этап 2.9 — выборочная интеграция, 27.09.2026

Приняты структурированные расписания и ожидаемое присутствие NPC, ограниченная история связей и знаний, история переносов встреч, более строгий гейт снятия состояний, финал и продолжение арки, HTML-книга, группы последствий и мемоизация ленты. Исправлены пересечения и перезапись смен, лечение чужого персонажа, снятие состояний дорогой/выбрасыванием предмета, старая главная цель после финала и потеря архивного эпилога в экспорте. Неявка и штрафы по границам хода отклонены: остаётся уведомление о просрочке. [Матрица решений](../../revision-2.9-integration-review-2026-09-27.md), [контракты и ограничения](../../world-social-and-consequences.md). Полные WORLD-2/3, MECH-4, NARR-3, PWA и живое качество AI не объявляются завершёнными.

### Этап 2.8 — выборочная интеграция, 27.09.2026

Из [кандидатной ревизии](../../revision-2.8-integration-review-2026-09-27.md) перенесены повестка событий и цели NPC, предпочтения голоса рассказчика, серверные модификаторы состояний и карточка «Ранее в истории». Исправлены ложное закрытие событий после одного промпта, проверка назначений и целей по итоговому рассказу, время от начала хода, привязка неизвестного/неоднозначного NPC, снятие голода и усталости временем, память об истёкших состояниях, область 2d6-модификаторов и строгая схема переносимого JSON. [Контракты и ограничения](../../world-agenda-and-narrator.md). Реальное качество повествования и соблюдение границ этим этапом не доказаны.

- **Приоритет владельца от 20.09.2026:** функциональность универсальных интерактивных историй важнее подготовки публичного сервиса. Повседневная жизнь и социальные сцены — полноценные сценарии использования. Ближайшее развитие: действия с состоянием мира, память, последствия и управляемая визуализация через исследование Pollinations/Vertex AI. Публичная защита остаётся обязательным условием внешнего запуска, но не первым продуктовым релизом.

- Универсальная интерактивная история: жанр и профиль механик задаются кампанией; d20 не является общим допущением.
- Пресеты поддерживают детерминированный автономный движок. Свободные кампании — AI-first, без шаблонного продолжения при недоступности Gemini.
- Модель предлагает изменения; сервер валидирует и применяет последствия. Канонические факты опираются на подтверждённое состояние и источники.
- Код поддерживает отдельные гостевые профили и необязательные аккаунты. Публичный запуск всё ещё требует эксплуатационных проверок SEC-1/INFRA-1, резервного копирования и настройки секретов.
- Миграции сохраняют старые данные. Контрольные точки фиксируют текущее состояние, не восстанавливают произвольное прошлое.

### Этап 2.7 — жизнь мира, взаимодействия и ручные визуалы

- **Интегрировано:** `clock`, форма истории `scene/open-life/arc`, commitments и holdings в `world_state`; контекстные действия с единым parser/availability contract; intent-gate и безопасное применение transfer/commitment/story changes.
- **Интегрировано:** миграция `0014_scene_visuals`, визуальные identities и scene visuals, ручные scene/location/portrait записи, owner-scoped API, атомарный дневной лимит и ограниченный Pollinations adapter.
- **Адаптировано:** Content-Length и stream cap на 8 МБ, session-scoped render updates, корректная гонка identity, частичный возврат stack item, строгая проверка отсутствующих сущностей и invalid commitment time.
- **Отложено:** durable media queue, VIS-0 benchmark, reference input, второй provider и авто-предложения. Режим без pgvector также отложен: историческая миграция `0006` не переписывается; нужен отдельный append-only дизайн.

## Реализовано в текущем коде

| Направление | Фактический результат | Основные источники |
|---|---|---|
| ARCH-1 / MECH-1 | Режимы preset/free, профили d20/rules-light/narrative, восемь миров, свободные кампании | `src/lib/profiles.ts`, `scenarios.ts`, `new-scenarios.ts`, `engine.ts` |
| RES-1 / INV-1 | Runtime-проверка resolution и reducers для ресурсов, инвентаря, локаций, квестов, NPC и объектов сцены | `src/lib/resolution.ts`, `turn.ts` |
| Надёжные ходы | Admission до AI, requestId и expectedTurn, lease/fencing, результат вместе с состоянием в транзакции, восстановление после reload | `src/lib/turn-admission.ts`, `src/components/use-turn-request.ts` |
| MEM-1 / MEM-2 | Канонические факты и provenance, semantic extraction, hybrid retrieval, gemini-embedding-2, очередь векторов и reindex | `src/lib/memory.ts`, `memory-jobs.ts`, `embeddings.ts` |
| Фоновые задания | Durable-задания в PostgreSQL, leases, retries/backoff, worker CLI, heartbeat и ручной проход на `/system` | `src/lib/background.ts`, `system-status.ts`, `scripts/memory-worker.ts` |
| Ветки | Immutable checkpoints, независимые forks с переносом состояния и памяти, согласованная компакция | `src/lib/checkpoints.ts`, `checkpoint-snapshot.ts`, `compaction.ts` |
| DATA-1 | Двадцать одна аддитивная миграция (0000–0020) в Drizzle ledger, отдельный migration runner и скрипт проверки чистой БД/повторного применения | `drizzle/`, `scripts/migrate.ts`, `migrations-check.ts` |
| Управление историями | Архив, переименование, удаление, избранные миры, полный Markdown export, загрузка ранних ходов | `src/app/api/`, `src/components/story-records.tsx` |
| Дизайн-система | Токены цветов, типографики и движения, адаптивные страницы, reduced motion, UI-аудит | `src/app/*.css`, `scripts/ui-audit.ts` |
| UX-1 | Серверные настройки размера прозы, ширины строки, трёх палитр и движения; раннее применение косметического кэша до запросов профиля | `src/lib/reading-preferences.ts`, `src/app/api/workspace/route.ts`, миграция `0003` |
| NARR-2 | Интерактивная карта открытых локаций: связи, риск, текущая точка, крупный диалог, подстановка перехода в поле действия | `src/components/world-map.tsx`, `src/lib/world-graph.ts` |
| INTERACT-1/2/3 | Контекстные действия, доступность сущностей, clock/story/commitments/holdings и intent-gate для claim/ask/intend | `src/lib/interactions.ts`, `src/lib/world-life.ts`, `src/lib/turn.ts` |
| NARR-7 | Формы `scene`, `open-life`, `arc`, границы глав и редактирование story shape владельцем | `src/lib/world-life.ts`, `src/app/api/sessions/[id]/route.ts`, `src/components/life-panel.tsx` |
| WORLD-2/3 (срез 2.8) | Отложенные события с отдельными сроком и подтверждением в рассказе; раскрытые цели и распорядок NPC | `src/lib/world-agenda.ts`, `src/lib/turn.ts`, `src/components/world-agenda-panel.tsx` |
| MECH-4 (срез 2.8) | Ограниченный каталог состояний для d20/2d6, короткие таймеры и отображение модификаторов | `src/lib/conditions.ts`, `src/lib/engine.ts`, `src/components/play-room.tsx` |
| NARR-9/10 (срез 2.8) | Сводка возвращения, эпилог в Markdown, пять настроек голоса и границы содержания как пожелания игрока | `src/lib/recap.ts`, `src/lib/narrator-preferences.ts`, `src/components/recap-card.tsx` |
| DATA-1 (совместимость 2.8) | Строгий JSON-экспорт/импорт сохраняет необязательные поля жизни мира, повестки, голоса и таймеров | `src/lib/campaign-portable.ts`, `tests/campaign-portable.test.ts` |
| VIS-1/2 (MVP) | Ручные scene/location/portrait visuals, identities, seed, owner-scoped API, сохранение bytes и лимит provider response; администратор выбирает общую модель; с 19.10 доступны личный аккаунт и модель Pollinations, явная оплата и сохранённый источник повторов (`0020`) | `src/lib/visuals.ts`, `src/lib/visual-provider.ts`, `src/components/visual-model-settings.tsx`, миграции `0014`/`0015` |

Карта скрывает неоткрытые места в представлении, но это не контракт сокрытия всех данных API: снапшот кампании возвращает её локации. При публичном доступе правила раскрытия данных нужно определить отдельно.

## Реализация нового этапа

- **CREATE-1:** автозаполнение обоих шагов, сохранение пользовательских ограничений, Lite-only API и отдельный учёт creation, отмена устаревших ответов.
- **UX-3:** единый определитель типа действия, сохранение старого requestId/типа, переключение левого меню, закреплённый режим чтения, настройки поверх игры и формы создания.
- **JEV-1:** выключенное по умолчанию наблюдение за памятью, отдельные настройки TypeSafe, фиксированная модель, отчёт под lease и аддитивная миграция. Оценки не меняют канон.
- **EVAL-2:** подготовлены 24 сценария создания и 60 размеченных русскоязычных примеров памяти. Реальные прогоны и ручная оценка согласованности остаются открытыми; mock-проверки их не заменяют.
- **NARR-1:** реализован NDJSON-стриминг предварительной прозы, подтверждённый результат после commit, восстановление запроса и фоновое обновление панелей. Добавлены пакетная запись памяти, prewarm embeddings вариантов и метрики этапов. Реальное ускорение требует отдельного измерения; см. [эксплуатацию задержки хода](../../turn-latency-operations.md).

## Частично готово

| ID | Уже есть | Осталось |
|---|---|---|
| A11Y-1 | Skip-link, aria-live, горячие клавиши, стрелки/Home/End для вкладок, диалог карты с Escape | Проверка всех диалогов и порядка чтения скринридером, axe, масштаб 200%; подтвердить доступность всего пути игры |
| PERF-1 | Ограничение числа фактов в снапшоте, облегчённый список кампаний, `content-visibility` и мемоизация ленты, размеры изображений | Измерить LCP/CLS/INP и длинные истории, задать бюджет; виртуализация и prefetch — после измерений |
| NARR-3 | Чипы, отклонённые изменения, группы последствий, было → стало для отношений, ссылки на загруженный ход | Полные before/after ресурсов и целей, подтверждённая причинность, переход к ещё не загруженному источнику |
| NARR-4 | Подсказки первого хода по форме истории и пример свободного действия | Контекстное знакомство с памятью после первого факта и проверка онбординга в разных жанрах |
| INFRA-1 | Durable worker, CLI, `/system`, инструкция эксплуатации | Конфигурация постоянного сервиса, restart policy, мониторинг и проверка восстановления при аварии |
| ARCH-1g / MEM-2g / QUAL-1 | Контрактная матрица жанр × профиль × режим, mock-provider и проверки изоляции | Размеченная оценка retrieval и повествования на реальном провайдере; unit-тесты не доказывают жанровое качество |
| DOC-1 | README, инструкция worker и актуальный roadmap сверены с кодом; автоматизированный предрелизный срез DOC-1f выполнен, CI и изолированный unit runner действуют | Ручная смысловая сверка описаний, внешних URL и heading anchors при последующих поставках |

## NOW — функциональность и воспроизводимые проверки

Продуктовая последовательность уже получила первый вертикальный срез: универсальные взаимодействия и состояние мира → ручная визуализация сцен с сохранением облика → формы историй, время и отношения. Декомпозиция: INTERACT-1/2/3, VIS-0/1/2/3, NARR-7 в [подробном roadmap](../../development-roadmap-2026-09-20.md). Инфраструктурные задачи ниже развиваются вместе с функциональностью; SEC-1 — условие внешнего доступа, его приоритет не означает, что аккаунты нужно делать раньше игры.

Таблица ниже сохраняет технические условия готовности; после уточнения продуктового приоритета порядок строк не задаёт очередность функциональных релизов.

| ID | Работа | Критерий готовности |
|---|---|---|
| JEV-3 · P1 | Универсальное применение Jev: общий типизированный слой заданий, проверка эффектов и цитат, выбор сущности, границы знаний, маршрутизация и память | [Срезы JEV-3a–d](../../development-roadmap-2026-09-27.md): baseline → shadow → отдельное включение; измерить ложные решения, uncertainty, latency/стоимость; сохранить изоляцию и серверный контроль |
| SEC-1 | В коде реализованы аккаунты, ownership, admin guards и vault с ротацией; осталось проверить конфигурацию и восстановление при внешнем запуске | Чужие кампании, память, экспорт, checkpoints и настройки недоступны; ключи не хранятся открытым текстом; есть проверки доступа и миграция существующих данных |
| INFRA-2 | Атомарный резерв до каждой попытки реализован, общий проект и timezone учтены; далее измерение provider concurrency под нагрузкой | Конкурентные ходы и workers не превышают общий бюджет; освобождение/учёт резервов проверены при отказах |
| INFRA-1 | Метрики, per-instance heartbeat, readiness и Docker/systemd-шаблоны реализованы; реальный сервис ещё не развёрнут | После остановки процесса сервис возобновляет работу и обрабатывает просроченный lease; алерты проверены; резервная копия БД восстанавливается |
| DS-1 | CI baseline typecheck/tests/lint/build/PostgreSQL/browser и документационный срез DOC-1f выполнены; остаются правила токенов, визуальные эталоны и широкий UI-аудит | Ошибка контраста/переполнение блокируют воспроизводимую визуальную проверку; документационный gate не заменяет контраст/a11y-аудит |
| A11Y-1 | Завершить аудит взаимодействия, axe и ручную проверку скринридером | Полный игровой ход и диалоги доступны с клавиатуры, нет critical/serious axe-ошибок, масштаб 200% сохраняет функции |
| LEGAL-1 | Владелец выбирает лицензию и условия использования ассетов | Опубликована фактическая лицензия; README не заявляет лицензию до этого решения |
| VIS-1/2 MVP | Ручные визуалы сцены/места/портрета, identity passport, стабильный seed, owner-scoped metadata/bytes и дневной резерв | Добавить durable media queue, benchmark провайдеров, reference input и policy для object storage до внешнего использования |
| WORLD-1/2/3 | Clock, commitments, holdings, story shape, отложенные события и раскрытые цели NPC сохраняются в `world_state` | Расписания, ожидаемое присутствие и ограниченная история знаний/связей реализованы в 2.9; остаются наблюдаемое участие и автономные последствия, управление владельцем и границы знаний |
| NARR-9/10, MECH-4 | Сводка возвращения, эпилог экспорта, голос рассказчика, каталог состояний и короткие таймеры | Финал и продолжение реализованы в 2.9; остаются проверка голоса на живом AI, жанровые каталоги и семантическая проверка восстановления |
| INTERACT-1/2/3 baseline | Единый parser для кнопки и текста, проверки сущностей, intent-gate и безопасный transfer/commitment reducer | Multi-intent, отрицания, richer object state и MECH-2 после измерения ошибок heuristics |

Наличие защиты от cross-site запросов и проверки UUID в `src/proxy.ts` не заменяет SEC-1. Lease защищает запись состояния, но не гарантирует exactly-once оплату внешнего AI при аварии процесса.

## NEXT — качество памяти и глубина продукта

| ID | Работа | Критерий готовности / зависимость |
|---|---|---|
| EVAL-2 | Выполнить 24 сценария на Lite и 60 примеров на Jev; разметить согласованность, измерить ошибки/latency/usage | Реальные ключи, сохранённые отчёты и ручная проверка; Flash сравнивать только при выявленных недостатках Lite |
| WORLD-2b/3b | Расписания, история и явные исходы/исправления владельцем реализованы; для автономных последствий нужны наблюдаемое участие, подтверждённое правило и возможность исправления владельцем. По одним границам хода штрафов нет | Проверить на корпусе сцен, что отсутствие героя, перенос встречи и отмена различаются; без ложного ухудшения отношений или недоступности NPC |
| NARR-9b/10b | Экран и явное продолжение с архивом/сменой главной цели реализованы; оценка соблюдения голоса и границ на живом провайдере остаётся | Кампания продолжается без потери канона; отчёт по нескольким жанрам и нарушениям границ, без заявления гарантии по одному промпту |
| MECH-4b | Гейт действия/получателя/ресурса реализован эвристически; далее явный контракт восстановления, JEV-3b и жанровые расширения | Усталость/голод/лечение снимаются только проверяемым событием; ложные совпадения свободного текста измерены |
| JEV-2 | Исследовать ранжирование памяти по typed assessments | Только после EVAL-2; текущий пилот остаётся наблюдением без порога отбрасывания |
| QUAL-1 | Размеченный набор запросов/фактов по жанрам, hard negatives из чужих кампаний; recall@5/@8, precision, latency, стоимость; genre drift и противоречия | Сравнение vector-only/hybrid/MMR на одном наборе; отчёт с реальной моделью и проверкой отсутствия межкампанийных утечек |
| SCALE-1 / PERF-1 | Профилировать 100/1000/10000 фактов и конкурентные кампании, SQL query plans, provider concurrency, fairness по владельцам и бюджет контекста | Зафиксирован baseline и измерены узкие места; pgvector уже поддерживается; HNSW/ANN вводятся после benchmark с планом миграции и совместимости пространств |
| DS-2 | Живой каталог токенов и состояний компонентов, правила поверхностей и контраста | Документированы hover/focus/disabled/loading и использование токенов; `/design` реализована в 2.10: токены, пары контраста, состояния и API timing; полный аудит hover/focus/disabled и screen reader остаётся |
| PERF-2 | Измерить уже реализованный NDJSON-стриминг и полный путь хода на реальном провайдере | p50/p95 первого текста и commit, размер контекста, cold/warm retrieval, retries и расход prewarm; подтверждённый результат остаётся отделён от черновика |
| NARR-3 / NARR-4 | Подробные последствия с финальными ресурсами и состояниями целей реализованы в 2.10; остаётся завершённый контекстный онбординг | Пользователь видит, что изменилось и почему, и понимает свободное действие и память без внешнего руководства |
| UX-2 | Уже добавлены «Ранее в истории», «К началу истории» и переход к жизни мира; команды checkpoint/компакции и «ход N» реализованы; остаётся развитие навигации по недавним переходам | Действия используют существующие API и доступны с клавиатуры |
| VIS-0 | Составить корпус из 30 повторяемых сцен и сравнить Pollinations/Vertex по качеству, latency, отказам и стоимости | Сохранённый отчёт с реальными прогонами и выбранным scope provider; unit/mock проверки этого не заменяют |
| NARR-11 | Gemini, OpenRouter и Pollinations: транспорт, ключи, каталог, настройки и OAuth реализованы; 19.10 добавлены штатный вход без предварительной модели, HTTPS client metadata и кэшируемые персональные каталоги текста/изображений | [Контракт](../../text-providers-operations.md). Выбор по профилю владельца; назначение по отдельной кампании и живые измерения качества моделей остаются открытыми. Тестовый транспорт не равен live-валидации |
| INTERACT-4 | Адресные упоминания сущностей в чате и выбор при совпадении имён | Сохранены проверенные `kind`/ID/диапазон текста; имя из меню или свободного ввода можно разрешить явно, сервер повторно проверяет кампанию и доступность, недействительная ссылка безопасно превращается в текст; keyboard и screen reader проверены |
| PERF-4 | Production-срез выполнен: before/after гостя/аккаунта, p50/p95 данных и API, ранняя оболочка, синхронизация 5→1, сохранение 7→1; функции и Neon в Frankfurt, общий Fluid pool, запросы после подтверждённого SUSPENDED | [Замеры и границы](../../database-cold-entry-production-2026-10-19.md): по 10 браузерных точек, по одному общему cold-пробуждению до/после; отдельный platform init и устойчивый cold p95 не заявляются. Авторизация и приватные данные не кэшируются как источник истины |
| VIS-3 / VIS-2b | Предлагать изображения для значимых событий и передавать пользовательский reference через подписанный URL | Явное согласие, privacy policy, durable queue и модель с reference input; не включать автоматику до этих условий |

## LATER — авторские истории и переносимость

- **NARR-5:** версионированные scene graphs и story packs с правилами эффектов; переход от процедурных beats к авторским сценам, затем редактор паков.
- **NARR-6:** append-only event log и snapshots, replay reducers, branch-from-turn, различение гипотез и подтверждённых фактов, связи противоречий. Зависит от событийной модели; текущие checkpoints сохраняются.
- **MEDIA-2 / AUDIO-1:** изображения/аудио/PDF как источники канона с provenance, проверками типов/размеров и чанкингом; мультимодальная индексация и озвучивание. Сейчас память текстовая. Генерация иллюстраций VIS-1/2/3 вынесена в ближайшее продуктовое направление; изображения сами по себе не изменяют канон.
- **ECO-1:** JSON export/import со schemaVersion и remap ID; read-only публикация истории после SEC-1; PWA и офлайн-чтение. JSON export/import реализован; read-only публикация и приватные копии сохранены. HTML-книга для офлайн-чтения и manifest реализованы в 2.9; статическая офлайн-оболочка, условная кнопка установки и добровольное обновление вкладок с сохранением черновика реализованы в 2.10. Проверки установки на физических устройствах и защищённая приватная офлайн-полка остаются открытыми. [Контракт обновлений](../../app-updates.md).

## Проверка состояния перед релизом

1. Сверить зависимости и npm-команды, маршруты API/страниц, миграционный ledger, ассеты, лицензию и статусы этого файла.
2. Выполнить `npm run verify` и отдельно `npm run lint`.
3. На отдельной тестовой БД выполнить migration check, HTTP smoke и browser smoke по [README](../../../README.md#проверки).
4. Выполнить `npm run audit:ui` и `npm run verify:ui`; mock UI-проверку и реальную интеграцию фиксировать отдельно.
5. В отчёте указать дату, среду и реально выполненные проверки. Наличие скриптов или старого успешного отчёта не считать новым прогоном. Real-model evaluation и нагрузочные измерения проводить отдельно.

## История решений

- [Исходный roadmap v1](roadmap-initial-a6f9a55.md).
- [Аудит исходного движка](2026-09-17-audit-findings.md) и [исправления памяти](2026-09-17-memory-system-fixes.md).
- [Архитектура v2](2026-09-17-v2-architecture-upgrade.md), [аудит v2.1](2026-09-17-v2.1-audit-and-plan.md).
- [Надёжность и ветки v2.2](v2.2-reliability-and-branches.md).
- [Интерфейс v2.3](v2.3-interface-and-roadmap.md), [дизайн-система v2.4](v2.4-design-system-and-roadmap.md).
- [Решения интеграции v2.5](../specs/2026-09-19-revision-integration-design.md), [план интеграции](2026-09-19-revision-integration.md).
- [Эксплуатация worker](../../worker-operations.md).
- [Ревизия 2.8 и матрица решений](../../revision-2.8-integration-review-2026-09-27.md), [контракты этапа](../../world-agenda-and-narrator.md).

- [Ревизия 2.9 и матрица решений](../../revision-2.9-integration-review-2026-09-27.md), [контракты 2.9](../../world-social-and-consequences.md), [приоритеты и JEV-3](../../development-roadmap-2026-09-27.md).

## Дополнения повторной поставки 2.9

- **JEV-3a:** общий транспорт Choice, политики существующих narrative/memory потребителей, отмена, лимиты UTF-8 и привязанный replay. Источники/актуальность/ownership проверяет вызывающий серверный код; универсального кэша и автоматической проверки свежести нет.
- **JEV-3b:** отдельный инструмент оценки лечения, распорядка и знаний с явным покрытием; ещё не подключён к игровому ходу. Разметка, измерение ошибок и бюджетированный административный запуск остаются открытыми.
- **WORLD-10:** правки владельцем распорядка и знаний, provenance и защита от устаревшего удаления; API проверен изолированными тестами ownership, lease, stale-запросов и атомарного отката; браузерные проверки указаны в отчёте интеграции.
- **NARR-13:** просмотр последних 32 арок и переход к незагруженным ходам; не полный бессрочный архив арок.
- **MECH-5 / WORLD-2b:** необычные циклы времени, событийное присутствие и нечеловеческое восстановление остаются открытыми; текущие часы — 24 часа, окна daily/once.

Матрица решений и ответы об архитектуре: [повторная поставка](../../revision-29-addendum-review.md).

## Проверка Jev на синтетике · 2026-09-27

- **JEV-3c:** аудит narrative eval выявил низкое покрытие уверенными решениями; исправлен оценочный выбор проверок, добавлены метрики риск–покрытие, знаменатели, интервалы и хеши. Короткие промпты остаются экспериментом. Следующий этап — пары «утверждение–источник», измерение полноты извлечения и оценка финального рассказа после review/repair.
- **JEV-2 / JEV-3d:** выполнены 80 разрешённых платных запросов Jev на синтетике. Score и Noul доступны в отдельном оценочном прототипе; преимущества над Choice на проверенных задачах не выявлены. Score для дополнительных доказательств требует сравнения с настоящим vector retrieval, а не только лексическим baseline. Noul не включается в каждый ход и не отключает обязательные проверки.
- **JEV-3b:** utility-корпус не заменяет отложенную проверку лечения, распорядка и знаний; готовность этих механик по нему не объявляется.

Методика, измерения, ограничения и конкретные контракты применения: [исследование Jev](../../jev-narrative-evaluation-2026-09-27.md), [данные](../../evaluations/2026-09-27-jev.json). Production-пороги и политика обработки недоступности не изменены.

Продолжение **JEV-3c/d**: [научные основания и расширенная проверка](../../narrative-evaluation-evidence-review.md), [дополнительные данные](../../evaluations/2026-09-27-jev-research.json). Выполнены ещё 48 синтетических запросов (24 случая, 8 связанных семейств): идентичность, версии, намерения, реплики, знания, правила мира, время и недоверенный текст. Сравнены Choice и пара Noul; production-готовность не установлена. Следующие отдельные этапы — независимая разметка, оценка необходимых наборов доказательств через настоящий retrieval, длинные траектории и литературные рубрики. Для внешней проверки подготовлен [запрос Deep Research](../../deep-research-narrative-evaluation-prompt.md).

## Прикладной план после проверки Deep Research · 2026-09-27

Проверка первичных работ и применимости: [исследовательская спецификация](../../narrative-research-synthesis-2026-09-27.md). Библиография и эталоны внешних отчётов не принимаются без проверки. Независимые разборы gpt-6-sol использованы для методов и ограничений; новые платные Jev-прогоны на этом этапе не проводились.

- **JEV-3c / EVAL-2/3 / QUAL-1 — запланировано:** [корпус и оценка конвейера](2026-09-27-grounded-narrative-evaluation.md). Разделить selection/extraction/retrieval/verdict/repair, проверить достаточные наборы источников, итоговый текст и память. Oracle-контроль сохраняет тот же verifier; синтетические векторы не заменяют оценку настоящих embeddings.
- **JEV-2 / JEV-3d — запланировано:** [эксперименты Score/Noul](2026-09-27-jev-primitive-experiments.md). Score — дополнительные подтверждающие и опровергающие источники; Noul — добавление пропущенных проверок. Включение только при установленной практической пользе относительно текущего baseline/Choice и отдельном плане rollout.
- **JEV-3b / WORLD-8 / MECH-4b:** эти планы не закрывают проверку знаний NPC, лечения и распорядков. Они дают инструменты измерения ошибок; допуск механик требует их собственного корпуса.

Статус: исследовательские решения и планы подготовлены; реализация новых протоколов, независимая человеческая разметка и контрольные прогоны остаются открытыми. Production-пороги, fallback, игровой ход и схема БД не изменены этим этапом.

## Дополнения интеграции 2.10

- **INFRA-3:** атомарная ротация scheduler по владельцам реализована; отдельные provider pools, нагрузочное измерение конкуренции и распределение квот остаются.
- **NARR-12:** размер первичного промпта и его фрагментов измеряется; динамическое сокращение только после сравнения качества.
- **PERF-1/2/4:** административный отчёт и opt-in Web Vitals дают инструменты для baseline, но не закрывают задачи оптимизации или реальных измерений.
- **WORLD-2b/3b:** ручные исходы договорённостей и исправления доступны владельцу; автоматические attendance и санкции требуют нового доказательного контракта.

### 2026-10-14: существующие замечания Security

Проверены пять ранее опубликованных замечаний RPG_arena: долговечная квота иллюстраций и ограничения импорта уже есть в main; общий резервный bucket входа остаётся документированным компромиссом для конфигурации без доверенного ingress. Для Jev сохранены выбранные владельцем внешний бюджет OpenRouter и продолжение игры при недоступности; добавлена ненавязчивая отметка сохранённого хода (см. [эксплуатацию проверки](../../narrative-verification-operations.md#доступность-jev-и-отметка-в-истории)). Дополнительный дневной лимит не вводится. Исправлен разбор JSON resolution с поясняющим текстом после объекта; это надёжность ответа, а не новая игровая механика. Новый security scan не запускался.
