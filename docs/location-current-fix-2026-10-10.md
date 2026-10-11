# Безопасная смена текущей локации — 10.10.2026

Владелец разрешил исправить слабое место внутреннего map executor, отмеченное в [предыдущем этапе покрытия](test-priority-coverage-2026-10-09.md). Исправление ограничено `loc.setCurrent` и прямыми регрессиями; остальные P1 из [матрицы покрытия](testing/coverage-matrix-2026-10-09.md) сохраняются.

## Причина и контракт

Ранее [executeLocationOp](../src/lib/location-ops.ts) сначала снимал `current` со всех локаций кампании, затем делал scoped update целевого UUID. Если UUID принадлежал другой кампании или отсутствовал, второй update не находил строку, а первый оставлял кампанию без текущей локации. Reducer уже отклонял такой ввод, но сам исполнитель зависел от этого предусловия.

Теперь исполнитель делает один SQL UPDATE. Внешний predicate ограничивает изменяемые строки своей кампанией; aliased EXISTS требует существующий целевой UUID в этой же кампании. `current` становится true только у цели, а CASE открывает только её, сохраняя `discovered` остальных строк. Нет отдельного предварительного SELECT и промежуточного сброса всех флагов.

- Чужой или отсутствующий корректный UUID оставляет полные local и foreign rows неизменными.
- Правильная local цель становится единственной текущей и открытой; остальные map fields и чужая кампания сохраняются.
- Повторный выбор той же цели сохраняет тот же результат.

Void API, accepted reducer operations, режимы и профили, JSON/DB schema и исторические миграции сохранены. Пользовательская UI-логика и provider contracts не менялись.

## Регрессии и проверка

[location-ops-db.test.ts](../tests/location-ops-db.test.ts) дополнен двумя invalid-target cases и положительной проверкой перехода/повтора. Все вызывают production executor через настоящую мигрированную SQL-транзакцию в PGlite. Fixture создаёт foreign campaign первой, а positive control сохраняет отдельную скрытую local локацию, discovery, coordinates, danger, icon и connections.

RED на исходном production-коде: обе неправильные цели снимали local current flag; positive control прошёл. После исправления map-discovery и location-ops-db прошли **19/19**, 0 fail/skipped/cancelled, exit 0. Logs и подробный отчёт исполнителя — `output/location-current-fix/red.log`, `green.log`, `implementation-report.md`.

Итоговый `npm run test:coverage`: **756/756**, 0 fail/skipped/cancelled, exit 0, 381782.815 ms. Это три дополнительные runtime registrations относительно previous753; location-ops-db содержит9, focused map-discovery+location-ops-db —19. Production build в изолированной среде, typecheck, lint и документационный checker завершились exit0. Independent review: spec PASS и code/test quality PASS, открытых actionable findings нет.

LCOV этого этапа756 содержит 172 loaded / 56 not-loaded src records и заархивирован с исходным SHA256 в `output/auth-races/prior-756-coverage.lcov`. Общий `output/test-coverage.lcov` теперь относится к [следующей проверке P1](p1-continuation-2026-10-10.md). Это raw Node/V8 counters для tsx-transformed loaded subset; whole-app/original-TypeScript проценты не заявляются. Previous753 LCOV сохранён побайтно в `output/location-current-fix/prior-753-coverage.lcov` с прежним SHA256; история runs остаётся в [машинной карте](testing/coverage-inventory-2026-10-09.json).

Нативный PostgreSQL8 run предыдущего этапа датирован09.10.2026 и отдельно сохранён; native map/concurrent deletion в этом исправлении не исполнялись. В основной `E:\Projects\RPG_arena` перенесены8 source/test/doc delta files после проверки исходных SHA256: сторонних изменений в затронутых файлах не было. Копии сверены побайтно. Там повторно прошли focused19/19, typecheck и lint; основной документационный checker завершился exit0:70 docs/269 local links. Delivery manifest и отдельные logs находятся в `output/location-current-fix/`.

Служебные baseline backups первоначально имели `.ts` и попадали под общий tsconfig glob, что дало missing-relative-import errors в первом typecheck/build. Они переименованы в `.baseline`; настройки проекта не менялись. Исходные failure logs сохраняются как `initial-typecheck-archive-failure.log` и `initial-build-archive-failure.log`.

## Пределы

Регрессии проверяют реальную SQL-семантику и отсутствие нежелательных записей на PGlite. Они не устанавливают поведение при конкурентном удалении локации другим PostgreSQL process, аварии БД или worker restart. Смена current флага одной SQL-операцией устраняет обнаруженный сброс при уже чужом/отсутствующем UUID; отдельные concurrency сценарии требуют native fixture.

Исполнитель — `gpt-6.1-sol` с reasoning medium, независимый reviewer — та же модель с high. Работа продолжается в прежнем изолированном worktree; исходные файлы предыдущего этапа сохранены и проверены SHA256 перед началом. Рабочая БД, реальные credentials, оплачиваемые providers и deployment не использовались.
