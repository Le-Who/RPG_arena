# P2: пакетные изменения, social evidence и транспорт провайдеров

Дата: **15 октября 2026**, Europe/Kiev. Продолжение [арифметики/transfers/timers](p2-state-test-coverage-2026-10-15.md) по строкам 4/7/20 [матрицы покрытия](testing/coverage-matrix-2026-10-09.md). [План](superpowers/plans/2026-10-15-p2-boundary-test-coverage.md) фиксирует область и разделение задач.

Повторно использован attached worktree `p2-state-test-coverage` от `27ed12b`, сверенный и побайтно заполненный из текущих 563 active main files, включая предыдущие незакоммиченные изменения. Исполнители — gpt-6.1-sol: reasoning medium для parser/reducer и high для social/persistence, async provider/cache и независимого review. Safe preload, fake loopback DATABASE_URL, disposable PGlite и synthetic transport; рабочая БД и платные модели не использовались.

## Новое покрытие

| Файл | Registrations | Реальная граница и буквальные ожидания |
| --- | --- | --- |
| `tests/resolution-batch-p2.test.ts` | 24 | parseResolution→applyResolution, malformed JSON envelopes/nested values, valid siblings, immutable inputs; sequential same-stack consume/remove/add, alias/ambiguity, quantity/resources/applied/consumedItems |
| `tests/social-evidence-boundaries-p2.test.ts` | 47 | Daily/once overnight activity, waits, symmetric overlaps, touching endpoints, scene/owner admission, presence/default clock; exact provenance и actual persisted turn с authored refusal/acceptance |
| `tests/provider-boundaries-p2.test.ts` | 15 | Real Response/ReadableStream, fragmented multiline SSE/CRLF/Unicode/ignored fields/usage, exact content/frame/wire limits, backoff abort, callback exceptions; public catalog loader и GET с pending/TTL/failure/recovery/provider isolation/cloned results |

Всего **86 runtime registrations**, включая nested и parent blocks, не количество assertions. Production изменён только в resolution.ts, world-social.ts и text-provider.ts. World-agenda.ts, text-model-catalog.ts, turn.ts, schema/migrations и зависимости сохранены.

## Воспроизведённые ошибки и исправления

Объект JSON с невызываемым toString вызывал TypeError при числовой нормализации HP effects, quest progress, NPC delta, inventory quantity или location danger и прерывал валидный gold sibling. Numeric fields больше не вызывают coercion hooks объектов/массивов; primitive conversion сохранён. Invalid quest progress становится null и сохраняет прежний прогресс. Quantity сохраняет действующий default1 при нечисловом значении, включая consume/remove: fixture явно проверяет остаток 2, HP +4 и consumedItems. Новый all-or-nothing batch protocol или strict quantity admission не вводился.

Daily overnight уже активно утром дня 1, но overlap сравнение отбрасывало его условное начало в дне 0 и допускало конфликтующее once-окно. Удалён только этот фильтр, согласовав scene/owner admission с slotActive. В persisted state не появляется день 0. Touching endpoint остаётся разрешённым, конец окна исключён.

SSE frame budget раньше не учитывал newline между data-строками: 250001 joined code units допускались. Теперь newline входит в бюджет, 250000 сохраняет положительный control. Отдельно проверены generated content200000/200001 code units и wire2000000/2000001 bytes, включая ignored Unicode reasoning.

External callback exceptions могли показать raw message, вызвать дополнительный provider request или повторно отправить successful telemetry как provider failure. Synchronous start/text и sync/async telemetry exceptions теперь безопасно завершаются CALLBACK_ERROR без такого повтора, следуя существующему shared Gemini contract. Event barrier при установленном 2-second backoff timer подтверждает немедленную отмену без второго admission/fetch. Endpoint/request/upstream API contract не менялся.

Каталог уже корректен и production не менялся: actual loader/GET разделяет pending fetch, возвращает clones, изолирует providers, считает TTL от завершения, даёт hit при59999ms и refetch ровно в60000ms; shared failure не отравляет immediate shared recovery/cache. Fake clock и response barriers заменяют ожидание.

## Provenance, genuine RED и fixture corrections

Misleading quote о другом NPC или завтра проходит действующую exact-source provenance проверку — это явно зафиксировано. Actual performTurn с authored contradicts verdict отказывает без canonical state/game turns/memory/jobs. Valid current pronoun context с authored consistent сохраняет literal knowledge/schedule/goal, applied, semantic keys и extraction job. Эти GREEN на исходном production доказывают применение решения, а не новую семантическую проверку.

- Batch: baseline54/54; original19pass/5genuinefail; focused78/78, target diagnostics0. Quantity regression после RED усилена remove→consume с тем же исходным pre-dispatch exception.
- Social: baseline28/28; corrected original45cases,43pass/2genuinefail; final47new + baseline =75/75. Ранние fixture failures — narration field ordering и выключенный semantic extraction — сохранены отдельно и исключены из genuine RED. Позже исправлен test hint type и добавлены два positive controls.
- Provider: baseline20/20; original15cases,9pass/6genuinefail; green15/15, focused75/75, release15/15. Шесть failures относятся к frame accounting и callback classification/reporting. Два implicit-any mock URL parameters исправлены до freeze.

Координаторские `.ts` preimages первоначально попадали в широкий tsconfig include и переименованы в `.ts.preimage`; TypeScript config не ослаблялся. Все fixture/type corrections завершены до общего freeze. Искусственные source mutation controls не выполнялись. Raw logs, worker reports и incremental source diffs находятся в `output/p2-boundary-coverage/`.

## Общая проверка и доставка

| Проверка | Фактический результат |
| --- | --- |
| Полный `npm run test:coverage` | **997/997**, exit0, fail/cancelled/skipped/todo0, 654514.3884ms |
| Независимое review | **86/86**, exit0; no actionable findings;440frozenfiles unchanged |
| `npm run typecheck` / `npm run lint` | exit0 / exit0; все fixture/type corrections завершены до freeze |
| Штатный `npm run build` | exit0, Next16.3.8 Turbopack; physical snapshot, все440frozenfiles byte-equal; safe OS allowlist, fake DB, без .env |
| Документация | checker78Markdown files; итоговый main checker и доставка имеют отдельные logs |

Ordinary suite вырос **911→997**. Source/test/script/config bytes оставались неизменными на всём full run; предыдущий911 LCOV и все прошлые runtime histories сохранены с hashes. Machine inventory обновляет125ordinaryfiles,707static AST calls и current LCOV без превращения raw V8/tsx counters в original-TypeScript/whole-app процент.

Build повторно использовал принадлежащий этой работе physical dependency snapshot предыдущего этапа. Его437прежних frozen files сверены до обновления, затем440новых после копирования и после сборки. Provider/SQL credentials не наследовались; Next config, package/lock и зависимости не менялись. Доставка main фиксируется ниже после пропорциональных проверок.

## Пределы и дальнейшие приоритеты

Quote provenance не доказывает NPC/time/semantic truth. Authored verdicts не являются независимой разметкой и не измеряют live quality; JEV-3/MECH-4b и corpus остаются отдельными задачами. PGlite исполняет all20 numbered migrations, но не доказывает native contention/process failover. Presence — ожидаемое расписание, без перемещения NPC rows.

Callback tests покрывают synchronous onText/onAttemptStart и sync/async onAttempt rejection, но не расширяют promises из void callbacks или deadline зависшего external callback. Synthetic streams и module-local fake-clock catalogs не доказывают live compatibility/availability/load. Settings POST→GET selected config не добавлен этим этапом.

Следующие P2: settings save/load, keyboard composer/owner editors, текущая карта/reporter lifecycle, legacy-data migration replay, дополнительная snapshot/holding ambiguity и независимая AI evaluation. Native38 от 10 октября остаётся историей; новые native/browser/live/deployment проверки здесь не выполнялись. Существующие task IDs сохранены; commit/push не выполняются.


В E:/Projects/RPG_arena перенесены только 13 файлов этапа после проверки всех 563 main preimages. Все 440 source/test/script/config files совпадают побайтно с freeze. Fresh main86/86 новых registrations, fail/skipped/cancelled/todo0; typecheck и global lint exit0. Full997 и isolated build на идентичных исходниках не дублировались. Main logs, source proof и delivery manifest сохранены рядом; предыдущие изменения сохранены, commit/push не выполнялись.
