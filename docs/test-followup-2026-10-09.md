# Дополнение к аудиту: зависимости, CLI и native PostgreSQL

09.10.2026 владелец подтвердил следующий ограниченный этап после [аудита кодовой базы](test-coverage-audit-2026-10-09.md): убрать неиспользуемый Drizzle Kit, исполнить существующие native PostgreSQL проверки и покрыть оставшиеся негативные ветви CLI evaluator. Работа выполнена в отдельном managed worktree с точной копией 52 ранее проверенных изменённых/новых файлов. Исходный каталог сохранялся до завершения проверок.

## Зависимости

`drizzle-kit` не используется активными source/tests/scripts или npm commands. Существующий `scripts/migrate.ts` использует `drizzle-orm/migrator`, `pg` и application runner; он остался побайтно неизменным. Удаление dev dependency и её lock entries убрало устаревшие `@esbuild-kit/esm-loader`, `@esbuild-kit/core-utils` и `esbuild 0.18.20`.

Проверка удаления выявила настоящую зависимость трёх browser scripts: они напрямую импортируют `esbuild`, который раньше случайно получали через Drizzle Kit. Первые gallery/update-guard runs отказали с `MODULE_NOT_FOUND`. Поэтому `esbuild 0.28.2` объявлен явной dev dependency — той же версии, которую уже использовал `tsx`. После этого gallery, update guards и performance panel прошли в Chromium. Для runtime приложения и historical SQL изменений нет.

Текущий `npm audit`: **5 high, 0 moderate, 0 critical**, вместо прежних 9. Все пять entries относятся к одной цепочке `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`. Runtime audit с `--omit=dev` — **0**. Принудительный downgrade tools не применён; оставшийся `braces` advisory не имеет опубликованной patched version на момент проверки. Результаты audit и npm dependency tree сохранены в `output/test-followup/`.

## CLI evaluator

[story-draft-eval-cli.test.ts](../tests/story-draft-eval-cli.test.ts) теперь содержит **13 runtime cases**, сохраняя пять предыдущих. Восемь дополнительных выполняют настоящий CLI subprocess с принадлежащими тесту loopback HTTP servers:

- Незавершённый body после отправленных headers и части JSON: все 24 source requests действительно достигли этой фазы, CLI применил deadline и закрыл соединения до cleanup.
- Отдельный deadline до получения response headers.
- Отказ от 302: source получил 24 запроса; redirect target получил **0 requests и 0 cookies**.
- Exact `--expected-model` match с 24 независимо написанными structural patches и противоположный near-match control.
- Malformed JSON, синтаксически обрезанный JSON с законченной HTTP body и недопустимая patch shape.

Отказы проверяют буквальные exit/status/error codes, содержимое сохранённого отчёта и отсутствие synthetic cookie/body sentinels в output/report. Оба timeout cases используют `--timeout-ms=200`, ограничивают subprocess 8 секундами и проверяют actual close events до teardown.

Исходные пять cases прошли; все 13 прошли уже на первой расширенной проверке. Production evaluator исправлять не потребовалось: его SHA256 и bytes совпадают с исходным каталогом. Исполнитель проверил четыре контролируемые мутации — удалённый deadline, разрешённый redirect, prefix вместо exact-model equality и сырая parser error. Все дали ожидаемый отказ; после каждой исходный script восстановлен, затем 13/13 снова прошли. Отдельные raw mutation logs не сохранены: это явно обозначенное implementation evidence из отчёта, а не независимо повторённый reviewer run. Основные GREEN logs и сам тест доступны для повторения.

CLI tests подтверждают execution/error/identity contracts. Они не устанавливают литературную связность, реальную стоимость или качество живой модели; `pending-human-review` сохранён. Проверка truncated JSON также не объявляется проверкой всех видов transport framing failure.

## Native PostgreSQL

Существующие три integration fixtures выполнены **без skip** на отдельном PostgreSQL **16.15** для Windows:

| Fixture | Результат |
| --- | --- |
| [auth-postgres.integration.ts](../tests/integration/auth-postgres.integration.ts) | Конкурентные account claims и ownership fencing: pass |
| [campaign-portable-postgres.integration.ts](../tests/integration/campaign-portable-postgres.integration.ts) | Lock admission, конкурентные повторы import/export и tombstones: pass |
| [quota-postgres.integration.ts](../tests/integration/quota-postgres.integration.ts) | Конкурентные reservations и фактический transport fetch admission: pass |

Итог: **3 tests, 3 pass, 0 fail, 0 skipped, 0 cancelled**, exit 0, **3771.7084 ms**. Три fixtures, preload и migration 0006 остались побайтно неизменными. Настоящих application bugs эти проверки не выявили.

Runtime получен по официальной цепочке PostgreSQL Windows → EDB binary ZIP, версия закреплена как `postgresql-16.15-5-windows-x64-binaries.zip`. Записаны URL, redirect headers, размер и локальный SHA256 `43BB45F173A6F08CF1D29A97A6D8DEB119E8E8093A24C00D2D1001A0CCAA8281`. Контрольная сумма обеспечивает идентификацию скачанного архива; отдельная vendor signature не проверялась. Системные services, PATH, registry и firewall не менялись.

Новая owned data directory, `127.0.0.1:55439`, fixture-only role/database/password, SCRAM и UTC проверены перед запуском. Каждый тест создаёт собственную random schema и удаляет её в `finally`. После тестов осталось **0 public tables**; после остановки проверенного owned PID — **0 listeners, 0 owned PostgreSQL processes**, `postmaster.pid` отсутствует. ZIP/runtime/data сохранены в isolated worktree под ignored `output/test-followup/native-postgres/` для повторения; в основной каталог доставляются logs и scripts.

Fixtures намеренно применяют **19 из 20** SQL-файлов, исключая historical `0006_database_memory_search.sql`. Поэтому этот run доказывает названные relational/concurrency contracts и не подтверждает полный pgvector migration/replay или production readiness. Исходные migrations/readiness ради окружения не изменены.

## Сводная проверка и review

| Проверка | Результат |
| --- | --- |
| Полный текущий `npm run test:coverage` | **687/687 pass**, 0 fail/cancelled/skipped, exit 0, **191520.6435 ms** |
| Native PostgreSQL | **3/3 pass**, 0 skipped, отдельный run |
| Focused CLI | **13/13 pass**, первоначально 5/5 |
| `npm run build`, затем `npm run typecheck` | Exit 0, Next.js 16.3.8 |
| `npm run lint` | Exit 0 |
| Chromium bundles после явного esbuild | Gallery 10, update guards 11, performance panel 7 checks, exit 0 |
| `npm run check:docs` | Exit 0, 67 docs / 247 local links |
| Доставка в исходный каталог | 8 delta files, SHA256 equality; повторные npm ci, typecheck, lint и CLI 13/13 в основном каталоге прошли |

Fresh independent review сопоставил именно текущий baseline исходного каталога с follow-up delta, прочитал CLI/native evidence и подтвердил отсутствие actionable implementation findings. Reviewer отдельно проверил equality production script/migrations/fixtures и отсутствие PostgreSQL процессов/listener. Финальные проверки выполнены координатором и привязаны к завершённым logs; документация и delta прошли отдельную сверку.

Итог доставлен в `E:\Projects\RPG_arena` с сохранением прежних изменений. Полный suite/build выполнен в изолированной копии; доставленные source/test/package bytes совпадают. После `npm ci --ignore-scripts` в основном каталоге повторно прошли TypeScript, ESLint и все 13 CLI cases; test-run duration — 12439.8175 ms. Бинарники/data portable PostgreSQL и новый worktree сохранены по исходному isolated path для повторной проверки; сервер остановлен. Generated logs и reproducible scripts находятся в `output/test-followup/`.

Схема и машинные результаты обновляются в [матрице](testing/coverage-matrix-2026-10-09.md) и [JSON-карте](testing/coverage-inventory-2026-10-09.json). Исторические **674/679** runs сохраняются со своими log/LCOV hashes; текущие V8/tsx counters относятся только к loaded transformed source subset, без original-TS или whole-app процентов.

Локальные доказательства: `output/test-followup/cli-report.md`, `native-report.md`, `review.md`, `final-coverage.log`, build/type/lint/audit logs, `native-postgres/native-run-1.tap.log` и `cleanup.json`. Real campaign DB, paid providers и deployment не использовались. Native full-turn fencing, worker fairness, расширенная route matrix, multi-build PWA и независимая разметка AI остаются отдельными пунктами backlog.
