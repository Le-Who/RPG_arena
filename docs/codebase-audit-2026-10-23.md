# Аудит кодовой базы · 23 октября 2026

Проверен рабочий код Chronicle Engine от коммита `b0b0fc1`: серверные маршруты, движок, сохранение и перенос состояния, фоновые задачи, провайдеры, клиентские сценарии и инструменты проверки. Работа распределена между тремя аудиторами; движок проверялся с reasoning `xhigh`, API и интерфейс — `high`. Общие инструменты и интеграцию проверял координатор; отдельный ревьюер с `xhigh` проверил итоговый diff и независимо перепроверил исправления своих двух замечаний. Открытых подтверждённых замечаний после ревью не осталось.

Сохранены режимы `preset`/`free`, профили `d20`/`rules-light`/`narrative`, необязательность боёв и проверок, русскоязычный интерфейс. SQL-схема и исторические миграции не изменены. Зависимости установлены штатным `npm ci --ignore-scripts` под Node 22.23.3 из `.node-version`; lockfile сохранён.

## Исправления

Каждый дефект поведения сначала воспроизведён падающей регрессионной проверкой. Низкий контраст выявлен браузерным аудитом; затем проверен после изменения CSS.

| № | Причина и проявление | Исправление и подтверждение |
|---:|---|---|
| 1 | Частичный POST общих настроек записывал весь устаревший снимок, удаляя параллельно подключённые Gemini credentials и другие настройки. | Записываются явно переданные поля и связанные routing/key операции. Gated regression в `settings-save-latency.test.ts`. |
| 2 | Visual preferences записывались после logout во время загрузки body или каталога; поздний 401 уже не отменял UPDATE. | Свежая identity после body и непосредственно перед записью. `visual-settings-revocation.test.ts`. |
| 3 | Portable import после logout во время чтения body создавал кампанию под ранее захваченным account profile. | Повторная identity-проверка перед импортом. `import-identity-fence.test.ts`: 401 и отсутствие новых строк. |
| 4 | API `after` callbacks заново определяли владельца и могли использовать настройки нового владельца после переноса кампании. | Зафиксированный owner передаётся в фоновые циклы compact, commitments, social, reindex, fork и GET prewarm. Настоящий `auth.adopt` проверен в `compaction-background-owner.test.ts`. |
| 5 | Direct image response доверял MIME и принимал SVG/JSON либо несовпадающий raster format. | Сигнатура байтов должна совпадать с заявленным MIME. `visual-provider.test.ts`; старые success fixtures заменены на действительные PNG. |
| 6 | Admin Pollinations catalog мог зависнуть на transport, игнорирующем AbortSignal. | Общий hard deadline ограничивает fetch и body read, позднее тело отменяется. `visual-model-settings.test.ts`. |
| 7 | Ограничитель JSON body ждал зависший `cancel()` и не возвращал 413. | Отмена запускается без блокирующего ожидания. `http-input-stream.test.ts`. |
| 8 | Проверка Content-Type принимала `application/jsonp` и `application/json-seq`. | Сравнивается точный media type; параметры и регистр поддержаны. `http-input-stream.test.ts`. |
| 9 | Строковый индекс персонажа `__proto__` вызывал 500 при создании preset кампании. | Разрешён неотрицательный safe integer, сохранён прежний fallback числового out-of-range. `campaign-creation-input.test.ts`. |
| 10 | Статистика эмбеддингов перезаписывала одинаковый status для нескольких моделей. | Счётчики суммируются с сохранением campaign scope. `embedding-stats.test.ts`. |
| 11 | Объектные числовые поля model JSON и старого состояния вызывали TypeError при coercion. | Guards в life/agenda/social/condition timers и истории арок. `world-model-numeric-boundaries.test.ts`. |
| 12 | Явное `advanceMinutes=0` заменялось default и могло переводить мир на следующий день. | Fallback применяется только при отсутствии значения. Numeric/clock regression. |
| 13 | Совпадение имени NPC, цели или объекта сцены побеждало точный ref; неизвестный ref превращался в поиск по имени. | Точный key имеет приоритет, неоднозначные имена и неизвестные ссылки отклоняются. `resolution-entity-identity.test.ts`. |
| 14 | Передача вещей использовала NPC/location snapshot до последствий текущего хода. | Life/agenda/social получают проекцию принятых операций; dead/missing и новые получатели обрабатываются согласованно. `turn-life-state-consistency.test.ts`. |
| 15 | Побочная цель с названием главной завершала сюжетную арку. | Завершение проверяется по ID принятой операции над главной целью. Real `performTurn`/PGlite regression. |
| 16 | Два фоновых callback хода могли подхватить нового владельца. | Turn memory и choice prewarm передают expected owner в существующий fence. Regression проверяет отсутствие настроек и heartbeat нового владельца. |
| 17 | Rollback reading/favorites восстанавливал весь Workspace; старые ошибки и bootstrap перезаписывали новые изменения. | Откаты ограничены полями, reading writes упорядочены и привязаны к профилю, bootstrap учитывает revision/pending; update guard ждёт сохранений. `client-state-browser.ts`. |
| 18 | Поздний manual retry памяти A подменял содержимое выбранной кампании B. | Initial/retry загрузки используют общий version guard, смена кампании инвалидирует старые ответы и ошибки. Browser regression. |
| 19 | Спокойное движение сохраняло smooth scroll; отдельные команды игнорировали системное предпочтение. | CSS и общий PlayRoom reveal учитывают профиль и `prefers-reduced-motion`. Browser regression profile/OS. |
| 20 | Подписи карточки резюме использовали неопределённый `--muted` с тусклым fallback. | Использован существующий `--ink-3`; повторный аудит всех палитр и mobile. |
| 21 | Pricing parser падал на объектной единице тарифа, принимал массив за строку, заменял явный token на image и объявлял неподтверждённую text estimate полной. | Типовые guards, приоритет явной единицы, token-only text arithmetic, исключение условных сборов из примера и неполная оценка при неизвестных сборах. `model-pricing.test.ts`. |
| 22 | UI audit терял alpha после смешивания двух прозрачных фонов и пропускал низкий контраст. | Правильная RGBA-композиция, учёт html background и белой canvas-подложки. Автономный `ui-audit.ts --self-test`. |
| 23 | Общий UI mock не поддерживал read-only recap, поэтому returning-player состояние получало 501. | Явный синтетический recap; неизвестные endpoints и mutations по-прежнему завершаются 501. `ui-mock.test.ts`. |
| 24 | Workspace PATCH записывал полный снимок, поэтому два успешных запроса разных полей стирали изменения друг друга. | UPDATE ограничен переданными полями. `workspace-concurrency.test.ts`: управляемые гонки favorites/reading, reading/displayName, displayName/favorites; обе записи сохраняются. |
| 25 | При ревью строгих ссылок обнаружена регрессия: parser обрезал refs до 64, хотя generated scene key бывает длиннее, а portable key допускает 200. | Bound quest/NPC/scene refs согласован с persisted contract: 200. Creation→parse→update и три portable roundtrip regressions. |

## Охват

- **Движок и persistence:** admission, request idempotency, lease/fencing, atomic commit, resources, inventory/bindings, conditions, world life, agenda/social/commitments, applied changes, narrative guard/generation/evidence/review/verifier/agreement provenance, stream/history, memory normalization/write/search/jobs, compaction, checkpoint integrity, fork/copy/export, strict portable validation и ID remapping.
- **API и окружение:** account/guest identity, owner work и переносы, доступ к кампаниям, secrets/settings, quotas, Gemini/text transports, OAuth/catalogs, visual preferences/transport, query caches, `after` callbacks, pool lifecycle, readiness, startup/deployment migrations, Docker/CI/runtime policy, local braces fork и установленные зависимости.
- **Клиент:** AppShell/bootstrap/identity/drafts, PlayRoom/request recovery/history, StoryRecords, account/provider/settings forms, dialogs/focus/inert, palette, creator/import/copy/checkpoints, composer/autocomplete, inventory/world/life/social/commitments, gallery, PWA/update flows, reading и связанный CSS. Использованы bundled Next.js guides, соответствующие установленной версии.

Дополнительные подтверждённые дефекты в просмотренных путях не оставлены на потом. Перестройка модулей и обновление версий без доказанного дефекта не проводились.

## Проверки

Обычные тесты используют `tests/helpers/test-environment.ts`: одноразовые PGlite fixtures, недоступный рабочий DATABASE_URL и синтетические provider responses.

Уже выполнены:

- `npm test`: **1311/1311 passed**, без ошибок и пропусков; после завершения review отдельно повторены все 18 новых/изменённых test files: **118/118 passed**, без ошибок и пропусков.
- `npm run typecheck` и `npm run lint`: **exit 0** после исправлений review.
- Production `next build`: **exit 0** после исправлений review, с недоступной одноразовой DATABASE_URL, auto-migrate выключен, provider credentials явно пустые.
- `npm audit --json`: **0 известных уязвимостей**, включая dev-зависимости.
- `scripts/client-state-browser.ts`: **10/10** сценариев на 1440 и 390 px, с клавиатурой и profile/OS motion; также **10/10** на изолированном production server.
- `scripts/story-experience-browser.ts`: успешный повторный прогон после всех клиентских изменений.
- `scripts/ui-audit.ts` с `UI_AUDIT_MOCK=1`: **19 состояний**, `tiny:0`, `lowContrast:0`, `overflow:false`, `pageErrors:0`.
- `scripts/ui-verify.ts`: карта, dialog Escape, roving tabs, travel prefill, палитры и reading controls; `pageErrors:0`.
- `scripts/ui-audit.ts --self-test`: nested-alpha и root-background regressions прошли.
- Независимый reviewer: **43/43** fast regressions и затем **16/16** identity/workspace regressions, плюс собственные воспроизведения двух замечаний после исправления.
- `npm run check:docs`: **108 файлов, 468 локальных ссылок**, актуальные npm-команды и ledger миграций проверены; anchors и внешние URL не проверяются.
- `git diff --check`: **exit 0**.

Новые client-state browser regressions и contrast self-test включены в существующий CI после Chromium install и запуска изолированного production server. CI-конфигурация просмотрена независимым reviewer; Linux GitHub Actions локально не запускался.

Браузерные снимки и подробные логи находятся в игнорируемом `output/`. Нативные PostgreSQL contention/process integration не запускались: Docker и psql в текущем окружении недоступны; миграции и SQL-поведение проверяются штатными PGlite suites. Живые provider evaluations и операции с реальными кампаниями не выполнялись. Mock/unit/browser успех подтверждает проверенные контракты и регрессии, но не качество живого повествования, нагрузочные характеристики или production readiness.

## Воспроизведение клиентских регрессий

```powershell
node --import tsx --import ./tests/helpers/test-environment.ts scripts/client-state-browser.ts
node --import tsx --import ./tests/helpers/test-environment.ts scripts/ui-audit.ts --self-test
```

`client-state-browser.ts` требует отдельно запущенный изолированный loopback dev server по `SMOKE_BASE_URL` (по умолчанию `http://127.0.0.1:3197`). Для общего UI audit и keyboard verify также нужен отдельно запущенный изолированный сервер и `UI_AUDIT_MOCK=1`.
