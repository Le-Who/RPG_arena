# P2: checkpoints/forks, поиск памяти и доказательства договорённостей

Дата: **11 октября 2026**, Europe/Kiev. Исходный commit: `27ed12b6d97722508284ea1ed9a81d55ccfe6ae6`. Работа выполнена в отдельном managed worktree; прежний P1 worktree сохранён. Область — строки9/14/16 [матрицы покрытия](testing/coverage-matrix-2026-10-09.md), [план исполнения](superpowers/plans/2026-10-11-p2-persistence-memory-evidence.md).

## Изменения и регрессии

| Граница | Поведение до изменения | Итог и доказательство |
| --- | --- | --- |
| Точный интервал цитаты договора | `slice` обрезал завышенный `source.end`; совпавшая цитата допускалась с недействительным заявленным интервалом | `reduceAgreementProposals` требует `end <= sourceText.length`. Регрессия отказывает для narration и player intent, сохраняет допустимую точную границу. Это воспроизведённая ошибка структурного admission |
| Внутренний runtime verifier | `null`/`undefined` вызывали исключение после `try`; `verified` с null/array answers мог допустить черновик; неизвестный status мог вызвать repair | Проверка outer envelope внутри exception boundary возвращает `verification_failed` без repair. Семь malformed вариантов имеют RED→GREEN. Это совместимое усиление внутреннего/custom adapter: стандартный wire adapter уже строго проверял ответы |
| Резервный legacy поиск | При равных score порядок вставки определял отбор внутри layer cap и итоговый порядок: `[82,80]` вместо `[80,81]` | Однострочный UUID tie comparator согласует legacy с SQL. Actual legacy regression дала RED до изменения и GREEN после. Формула score, threshold и caps сохранены; это совместимое улучшение ранее неоговорённых legacy ties |
| Checkpoints/forks | Новая матрица прошла на исходном production-коде | Добавлено доказательство уже корректных контрактов; production persistence не менялась |

Исполняемые тесты: `tests/checkpoint-persistence-p2.test.ts` —9; `tests/memory-search-freshness-p2.test.ts` —5; `tests/narrative-evidence-p2.test.ts` —15 runtime registrations, включая семь nested subtests. Всего добавлено **29 runtime registrations в трёх файлах**; это не число assertions.

## Что выполняют тесты

Checkpoints/forks вызывают настоящие create/fork/delete services. `accountsDb` применяет все20 исходных numbered migrations с PGlite vector/pgcrypto. Проверены 12→13 limit, replay на лимите, освобождение места удалением, конфликты изменённых title/expectedTurn, replay сохранённого checkpoint после продвижения кампании и единственной branch. Удаление source checkpoint сохраняет state/entities/history/private owner, remapped IDs, двухревизионную цепочку договорённости, исходные quote/hash, memory parents/links/retrieval references и pending embedding outbox. Literal canon проверен для preset/d20, free/rules-light и free/narrative. Сохранившаяся branch создаёт собственный checkpoint.

SQL triggers вызывают настоящую ошибку23514 в середине копирования (`scene_objects`) и на последней вставке ledger (`checkpoint_forks`). Независимые SQL snapshots15 durable tables доказывают полный откат новой branch, истории и outbox, сохранение существующей branch и успешный однократный retry после снятия fault.

Поиск вызывает настоящий `searchMemory`, availability/transaction и pgvector SQL; заменён только pg transport к disposable PGlite. Здесь минимальная memory schema и неизменённая migration0006, **не all20 replay**. Тот же prewarmed query vector наблюдает новые importance/turn/currentTurn и literal IDs без provider fetch. Изменённый content исключается со старым hash или pending embedding; fresh hash/vector возвращают новый text и similarity. Проверены session/model/dims isolation, UUID ties до caps, threshold до scoring, layer cap после weighted ranking и final k. Legacy fixture временно удаляет helpers только в своей disposable DB, затем выполняет0006 и сравнивает обе ветви.

Evidence query выполняется с migration0009 на минимальном synthetic `game_turns`:48 допустимых story rows,24 высокорелевантных чужих rows, pending/future/system candidates. Actual bounded query возвращает40 допустимых rows с literal first/last pairs; player text остаётся intention, completeHistory=false. Agreement append/query выполняет migration0008, настоящий Drizzle transaction и journal read. Несовпадающий final narrator source оставляет zero rows; успешная запись сохраняет literal final narrator ID, offsets0/59 и UTF-8 SHA256, не меняя provisional input.

Для edited terms настоящая adapter/guard цепочка получает candidate и исходную историческую фразу; authored `contradicts` verdict останавливает guard. Fabricated quote отвергается review parser. Подлинная цитата может пройти структурную проверку с authored `consistent`: происхождение текста не доказывает смысловую поддержку новых условий. Эти fixtures проверяют передачу и применение решения, а не качество модели.

`snapshotVersion` в существующем Jev — локальная metadata task/outcome. Wire response не содержит обязательной версии, а turn consumer сейчас её не передаёт. Проверено действующее body-hash-bound recording/replay: изменённые условия при той же локальной версии не принимают stale replay. Новый wire protocol или production version fence не вводился. Шесть malformed provider fixtures проходят настоящий строгий adapter и дают unavailable/invalid_response без repair; configured outage bypass в turn остаётся отдельным действующим контрактом.

## Доказательства и проверки

Локальные raw logs и manifests сохранены в `output/p2-persistence-memory-evidence/`; output исключён из Git. Исполнение использует safe preload с фиктивным loopback DATABASE_URL и удалёнными provider/secret variables. PGlite закрывается в `finally`; рабочая БД и платные вызовы не использовались.

| Проверка | Фактический результат |
| --- | --- |
| Checkpoints existing baseline / original new cases / final focused |23/23;9/9;32/32, exit0 |
| Search existing baseline / original SQL cases / legacy RED→GREEN / final focused |5/5;4/4;1 intended failure→1/1;10/10, соответствующие exit1→0 |
| Narrative existing baseline / corrected-fixture original RED / final focused |42/42;6pass9fail exit1;57/57 exit0 |
| Consolidated ordinary `npm run test:coverage` | **853/853**, exit0, fail/cancelled/skipped0,564456.056ms |
| Typecheck / lint / production build / docs | exit0; isolated Next16.3.8 build с explicit OS environment allowlist, fake loopback DATABASE_URL и auto migration0 |
| Проверка после type-only fixture correction | **9/9**, exit0; fresh typecheck exit0; transpiled JavaScript побайтно совпадает |
| Независимое gpt-6.1-sol review | Нет дополнительных production findings; test type correction проверена координатором |
| Перенос в main |526preimages verified;13task files byte-SHA equal. Main focused **44/44**, exit0,38473.1728ms; fresh main typecheck/lint exit0 |

Narrative initial RED содержал ошибочную literal length/hash fixture; перед meaningful RED исправлена fixture. Первый SQL isolation control дал PG42P18 из-за untyped parameter и не засчитан. Исправленный control выполнил query и вернул `foreign-1` вместо `history-1-player`, дав intended assertion RED. Оба первых невалидных результата сохранены отдельно.

Девять независимых mutation controls подтвердили чувствительность проверок: пять checkpoint controls (limit/create conflict/fork conflict/branch deletion/transaction), три search controls (hash/tie/ranked cap), один evidence session control. Это искусственные RED для тестов, **не девять найденных дефектов**. После каждого изменённый production source восстановлен побайтно; hashes и raw причины сохранены. Broad gates запускались только после общего freeze. Первый global typecheck нашёл слишком узкий выводимый тип randomUUID arrays в checkpoint fixture; после full run добавлены только string[] annotations. Full-source-start manifest455files и freeze-validation доказывают неизменный production и идентичный transpiled fixture output; fresh9/9/typecheck прошли. Independent review сохраняет первоначальный pending статус, разрешённый этой проверкой координатора.

LCOV содержит176loaded/52not-loaded src records. Это raw Node/V8 counters поверх tsx-transformed loaded subset, не original TypeScript или whole-app процент. Node v24.13.0; старый824 LCOV сохранён с проверенным hash, все предыдущие runtime histories остаются отдельно.

Изменения находятся в E:/Projects/RPG_arena без commit/push. Перенесены только13files задачи; dependencies, migrations, ledger и public interfaces сохранились. Изначальный transfer manifest фиксирует preimages, конечный manifest обновляется после документации. Полный suite/build не дублировались на идентичных исходниках main; main проверил44affected cases, typecheck/lint и документацию.

## Пределы и следующий backlog

Этот этап закрывает перечисленные локальные P2 scenarios строк9/14/16. PGlite не доказывает native multi-process locking/networking, crash или ошибку COMMIT. Две fault-фазы fork не охватывают каждый chunk; расширенные snapshot size/legacy corruption boundaries остаются отдельным расширением. Нет новой оценки native PostgreSQL latency/query plans, семантической точности модели, public deployment или full vector readiness. Предыдущие native38 от10 октября остаются историческим результатом; в P2 они не запускались заново.

Остальные P2 матрицы сохраняются: resource arithmetic, batch controls, life/transfers/intent, conditions/timers, agenda/social evidence, provider/catalog caches, UI composer/owner editors, map/reporter/legacy migration boundaries и независимая narrative evaluation. Существующие MEM/NARR/SEC/ECO/UX/PERF task IDs не меняются. Commit/push в этом implementation turn не выполняются.
