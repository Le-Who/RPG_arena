# P2: арифметика ресурсов, передача предметов и таймеры состояний

Дата: **15 октября 2026**, Europe/Kiev. Продолжение [предыдущего P2](p2-persistence-memory-evidence-2026-10-11.md) по оставшимся детерминированным границам строк 3/5/6 [матрицы покрытия](testing/coverage-matrix-2026-10-09.md). [План исполнения](superpowers/plans/2026-10-15-p2-state-test-coverage.md) сохраняет область и ограничения.

Работа выполнялась в attached worktree `p2-state-test-coverage` от `27ed12b`, с побайтным переносом 13 незакоммиченных файлов предыдущего этапа. Исходный manifest основной директории содержит 558 файлов. Исполнители — gpt-6.1-sol: reasoning medium для арифметики и high для transfers/intent, условий и независимого review. Проверки используют safe preload, фиктивный loopback DATABASE_URL, disposable PGlite и синтетический транспорт. Рабочая БД и платные вызовы не использовались.

## Проверяемое поведение

| Граница | Результат и доказательство |
| --- | --- |
| Арифметика HP/XP/DC/risk | 34 новые регистрации с буквальными ожиданиями: HP перед нулём, на нуле и после overkill, восстановление до 1 HP и денежный штраф, healing cap, XP 119→120 и 239→240, рост DC по ходам и насыщение, risk 59/60/61 и 69/70/71. Настоящие serverCheck, offline engine и reducer проверяют итоговые counters, включённые ресурсы профиля и неизменность входа. Production арифметика уже была корректна |
| Утверждение о передаче | До изменения `claim` мог удалить последний предмет и создать владение NPC. Настоящие performTurn/PGlite и direct reducer дали genuine RED. Однострочный gate допускает передачу только при `act`; `intend/ask/claim` сохраняют предмет. Существующие proposed commitments сохраняются |
| Количество и происхождение владения | Alias references списывают stack один раз. Поддерживаемый цикл отдать 3 → вернуть 1 → вернуть 2 сохраняет inventory 0→1→3 и holdings 3→2→0; частичный возврат сохраняет ID держателя, описание и исходный ход. После полного списания name-based acquisition создаёт новую inventory identity, затем дополняет её. Это доказательство существующего контракта, без нового протокола возврата |
| Лекарство и пациент | До изменения известный non-consumable с лечебным именем допускал снятие состояния; фразы о самолечении врача могли лечить героя при упоминании героя рядом. Гейт теперь проверяет вид и субъект возвратного действия. Прямые legacy evidence без kind сохраняют прежнее поведение |
| Identity использованного предмета | Reducer возвращает transient consumedItems только для принятых consume операций. Turn consumer передаёт фактические ID/name/kind вместо первого одноимённого inventory row. Настоящий ход с consumable/tool namesakes проверяет literal accepted state verifier, returned applied changes, SQL inventory/character, сохранённый narrator content, semantic memory и extraction job |
| Таймеры | До изменения readConditionTimers принимал 1201 запись, неограниченные день/sinceTurn и нецелые либо бесконечные sinceTurn. Теперь максимум 100 допустимых записей, ключи до 100 символов, числовые границы строгого переносимого состояния и безопасные reserved keys. Legacy coercion/default сохранены. Повторный timer refresh через полночь, точное истечение, очистка orphan и отсутствие повторных событий уже работали и получили независимые проверки |

Новые файлы: `tests/resource-arithmetic-p2.test.ts` — 34, `tests/transfer-intent-p2.test.ts` — 8, `tests/condition-timers-p2.test.ts` — 16. Всего **58 новых runtime registrations**, рост ordinary suite **853→911**. Количество runtime registrations включает родительские и nested tests; оно не равно количеству assertions.

## Происхождение ошибок и проверок

Арифметика: baseline 20/20, новые 34/34 на исходном production, focused 54/54. Первые четыре неуспеха были ошибкой fixture: levelBefore/levelAfter ожидались внутри resources.xp вместо отдельного resources.level. Исправлена fixture; arithmetic production не менялся. Независимое task review подтвердило соответствие контракту и отсутствие target-file TypeScript diagnostics.

Передачи: baseline 26/26; original integration 5 pass/2 fail — один claim case плюс родительский wrapper. Отдельный direct reducer RED показывает неожиданный inv.delete. После исправления focused 66/66 с narrative-turn integration. Чтение намерения не изменялось: classifyIntent уже корректно возвращал claim.

Лечение и таймеры: baseline 11/11. Исходный genuine RED содержит 15 registrations, 7 pass/8 fail: два kind cases, два patient cases, numeric bounds, huge map, один actual turn плюс wrapper. До meaningful RED исправлен порядок выбора narrator row в fixture. После исправлений добавлена отдельная producer-seam проверка. Первый расширенный focused run имел 73 pass/1 fail из-за неточного literal rejection message; assertion исправлен на значимые поля поведения, production при этой коррекции не менялся.

Raw logs, отчёты исполнителей, review, исходный manifest и последующая проверка source freeze сохраняются в `output/p2-state-coverage/`. Искусственные source mutation controls в этом этапе не выполнялись; genuine RED не смешивается с исправлениями тестового окружения.

## Общая проверка и доставка

| Проверка | Фактический результат |
| --- | --- |
| Полный `npm run test:coverage` | **911/911**, fail/cancelled/skipped/todo 0, exit0, 710147.4354ms |
| Независимое combined review | **96/96**, exit0, без открытых findings; дополнительное arithmetic task review PASS |
| Typecheck / lint | exit0; после пяти type-only fixture corrections fresh global typecheck и affected-file ESLint exit0 |
| Штатный `npm run build` | exit0, Next16.3.8 Turbopack; отдельный physical snapshot с 437 совпадающими frozen files, safe OS allowlist, без .env и с фиктивным DB |
| Документация | exit0, 76 Markdown files / 303 local links; anchors/external URLs checker не проверяет |
| Inventory | 228 source / 143 test/helper/fixture paths по одному разу, 122 ordinary files, AST680calls; 7815 structured references и current/history LCOV/log hashes сверены |

Production source оставался стабильным на всём full run. Первый global typecheck выявил пять обращений к необязательному state в transfer fixture. Пять erased non-null assertions исправляют только типы; исходные bytes и оба esbuild outputs сохранены, их одинаковый SHA256 `0158e9fd01bb8c4d1b6926948c7115ae97ce687fd95c0a2ff1513531b1dd47f2` независимо перепроверен reviewer. Fresh fixture8/8, targeted diagnostics0 и global typecheck прошли. Initial/current freeze manifests сохраняют 437 файлов, runtime fixture output одинаков.

Первый build в worktree отказал из-за junction node_modules на другом диске: Turbopack запрещает такую ссылку вне filesystem root. Зависимости побайтно скопированы без npm install/изменения lockfile; обычный build прошёл в отдельном snapshot с теми же исходниками. Сборка не использует Webpack fallback или изменённую Next config. Автоматическая проверка заблокировала удаление этого временного build snapshot с причиной «blocked by policy»; каталог оставлен, результат отражён в build-cleanup.json.

LCOV содержит **176 loaded / 52 not-loaded src records**. Это raw V8/tsx transformed counters, не original-TypeScript или whole-app процент. Предыдущий LCOV на 853 registrations сохранён отдельно с совпадающим SHA256; история 674/679/687/753/756/757/823/824/853 остаётся доступна.

В `E:/Projects/RPG_arena` перенесены только 14 файлов этапа после проверки всех 558 исходных main preimages. Task files совпадают побайтно. Отдельная сверка 437 source/test/script/config файлов: 335 совпадают побайтно, 102 различаются только CRLF/LF, содержательных различий нет; для 99 TS/TSX/script файлов из этих 102 дополнительно совпадает transpiled JavaScript. Остальные три — CSS. Изначальная попытка raw freeze-проверки main обнаружила эти ожидаемые checkout line-ending различия; они проверены отдельно, source не переписывался ради нормализации.

Fresh main: **58/58** новых registrations, fail/skipped/cancelled/todo0, exit0, 11682.7006ms; typecheck и global lint exit0. Final main documentation checker: exit0, 76 files / 303 local links. Full911 и build не дублируются на содержательно идентичных исходниках. Delivery manifest, main-source-equivalence.json и main logs сохраняют эту границу. Предыдущие незакоммиченные изменения сохранены; commit/push не выполнялись.

## Пределы и дальнейшие приоритеты

Синтетическая narration/verdict проверяет серверное применение и сохранение, а не смысловую точность живой модели. Лечение остаётся ограниченной эвристикой русских фраз; нет общей NLP-модели пациента или физиологии. Legacy evidence без kind — совместимость прямого внутреннего API; production turn передаёт фактический kind. Transient consumedItems не добавляется в AppliedChanges, portable JSON, checkpoints или SQL-схему.

Арифметический DC 20 достигается синтетическим danger выше нормального диапазона 0–100; при обычном максимуме и насыщении turn escalation DC равен 17. Offline engine/reducer composition не заменяет persisted performTurn, а PGlite не доказывает native contention/process failures. При провале сохраняется предусмотренный прогресс XP до 10; нулевые награды всех видов не вводятся. Return lifecycle покрывает одного держателя; неоднозначность нескольких одноимённых holdings остаётся отдельной границей.

Следующие P2: batch/resource malformed controls строки 4, agenda/social presence и overnight bounds строки 7, provider SSE/backoff/catalog caches строки 20, keyboard/owner editors строки 22, карта/reporter/legacy migration replay строки 24 и независимая AI evaluation. Существующие task IDs сохраняются. Native PostgreSQL38 от 10 октября — историческое доказательство; в этом этапе native, browser, live providers и deployment не запускались.
