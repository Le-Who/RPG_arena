# Grounded Narrative Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Найти и измерить причины неверного допуска/отклонения рассказа в Chronicle Engine до изменения production-политики Jev.

**Architecture:** Отдельный offline-корпус с эталонными утверждениями и наборами источников, детерминированные преобразования и runner поверх существующего verifier. Затем captures из настоящего `performTurn` с синтетической генерацией, чтобы оценивать финальный текст, сохранённые изменения и память. Никакой новой схемы БД.

**Tech Stack:** TypeScript, node:test, tsx, PGlite/pgvector, существующие Jev transport/replay и narrative fixtures.

**Spec:** [Проверенная исследовательская основа](../../narrative-research-synthesis-2026-09-27.md).

## Global Constraints

- User-facing copy is Russian. Сохранять preset/free и d20/rules-light/narrative.
- Изменяются оценочные scripts/tests; production-пороги, fallback и обязательные проверки сохраняются.
- Нет обращения к пользовательской БД. `.env.eval` разрешён только явному live-runner, не unit-тестам.
- Источники ограничены кампанией/веткой и временем проверяемого утверждения. Старая версия допустима для исторического claim; она не заменяет текущую. Роль источника не равна истинности содержащейся реплики.
- Синтетические метки без независимой проверки обозначаются diagnostic; они не устанавливают production-готовность.
- Production-план интеграции нового оценщика создаётся только по результатам этого эксперимента.

## Текущие точки интеграции

| Существующий файл | Назначение |
|---|---|
| `src/lib/narrative-policy.ts` | Выбор областей проверки и `scopeNarrativeChecks` |
| `src/lib/narrative-verifier.ts` | `verifyNarrative`, версия задания, действующие пороги |
| `src/lib/narrative-evidence.ts` | Исторические источники, роли, усечение и хеши |
| `src/lib/memory-search.ts` | SQL поиска memory_nodes; это другой канал, чем поиск game_turns |
| `scripts/jev-evaluation.ts` | Существующие метрики и parser primitive-ответов |
| `scripts/eval-narrative-serialized.ts` | Оценка захваченного входа настоящего хода |
| `tests/narrative-turn-integration.test.ts` | PGlite, capture, repair/lease/state/memory; уже есть цепочка 20 ходов |

Не переписывать эти модули для исследования. Новые файлы ниже создаются, существующие дополняются узко. Перед выполнением проверить актуальные сигнатуры.

## Task 1: Корпус с проверяемыми эталонами

**Files:** Create `scripts/grounded-evaluation-cases.ts`, `tests/grounded-evaluation.test.ts`; Modify `docs/narrative-research-synthesis-2026-09-27.md` только для ссылки на готовый корпус.

**Interfaces:** Экспортировать `GroundedCase`, `Source`, `Claim`, `validateCase`, `groundedCases`. `validateCase(value: unknown): GroundedCase` либо возвращает проверенную копию, либо бросает `invalid_case`.

```ts
export type Gold = "supported" | "contradicted" | "unknown" | "no_claim";
export type Source = {
  id: string; sessionId: string; branchId: string; turn: number;
  authority: "accepted_state" | "verified_narration" | "speech" | "intention" | "legacy";
  text: string; validFromTurn: number; validToTurnExclusive?: number; supersededBy?: string;
};
export type Claim = {
  id: string; text: string; entityIds: string[]; atTurn: number;
  span: [number, number] | null; requiredCheckIds: string[];
  scope: "history" | "speech" | "belief" | "knowledge" | "transition" | "world_rule";
  gold: Gold; supportSets: string[][]; refuteSets: string[][]; rationale: string;
  transitionRef?: { captureId: string; operationIds: string[] };
};
export type GroundedCase = {
  id: string; scenarioId: string; templateId: string; family: string;
  split: "development" | "calibration" | "holdout";
  labels: "diagnostic" | "human_reviewed";
  mode: "preset" | "free"; profile: "d20" | "rules-light" | "narrative";
  sessionId: string; branchId: string; currentTurn: number;
  input: { narration: string; playerAction: string; stateBefore: Record<string, unknown> };
  sources: Source[]; claims: Claim[];
};
```

- [ ] Начать с тестов validator: неизвестный source ID; источник другой кампании/ветки; источник, появившийся после currentTurn; повторяющийся ID; пустой достаточный набор; несовместимые support/refute sets без явно unknown-разметки; no_claim с непустым утверждением. Лимиты: до 40 источников, 12 claims, 6000 символов на источник, 100000 UTF-8 байт на сериализованный case, 16 наборов каждой полярности, до 8 ID на набор. `span` — UTF-16 индексы начала включительно/конца исключительно в input.narration; no_claim имеет null. Validator проверяет форму и ссылки, не семантику русского текста.
- [ ] Различать `turn` появления источника и `[validFromTurn, validToTurnExclusive)` действия факта. Проверить case исторического claim со старой версией, корректной для atTurn, и текущего claim с новой. Ссылка supersededBy сама по себе не означает запрет использования в истории. Для transition в Tasks 1–3 обязателен зарегистрированный capture с pre/post-state и accepted/rejected operations; до появления такого capture в Task 4 исключать transition из claim-level прогона и учитывать как неподдерживаемый тип, а не confirmed.
- [ ] Реализовать validator и проверить ссылочную целостность; не выводить gold из ответа Jev. `human_reviewed` разрешать только при отдельном файле разметки с двумя независимыми оценками, rationale и разрешением разногласий. Агент не может сам присвоить эту метку.
- [ ] Создать по два диагностических базовых случая для 12 семейств: сущность, время, поправка договорённости, источник/реплика, намерение/успех, знание NPC, правило чужого мира, бытовая сцена, агентность, независимое получение, усечение, недоверенный текст. Это 24 smoke-сценария, не доказательство размера достаточной выборки.
- [ ] На development добавить 6 пар граничных примеров: обещание нарушено/обещания не было; NPC сказал X/X истинно; сон/реальность; старое/текущее владение; дар разрешён/дар получен; отсутствие информации/явное отрицание. Рationale обязателен, условия не дописываются после результата модели.
- [ ] Зафиксировать раздельные файлы аннотаций и provider request: эталон и rationale никогда не попадают в запрос. Проверить сериализованный request тестом на отсутствие `gold`, `rationale`, `supportSets`, `refuteSets`, `requiredCheckIds`. Поля stateBefore ограничить синтетическим JSON из capture, без секретов; валидировать размер всего case перед использованием.

**Проверка:**

```powershell
node --import tsx --import ./tests/helpers/test-environment.ts --test tests/grounded-evaluation.test.ts
```

## Task 2: Контроли источников и метрики без провайдера

**Files:** Create `scripts/grounded-evaluation.ts`; Extend `tests/grounded-evaluation.test.ts`. Не менять существующую семантику `selectiveMetrics` молча.

**Interfaces:** `hasSufficientSet(sets: readonly string[][], present: ReadonlySet<string>): boolean`; `removeSources(c: GroundedCase, ids: readonly string[]): GroundedCase`; `buildVariants(c: GroundedCase): { variantId: string; case: GroundedCase }[]`. Преобразования возвращают копии. Gold нового варианта задаётся явной разметкой; helper не объявляет истиной вывод из неполной разметки.

- [ ] Написать и запустить тест достаточных наборов:

```ts
assert.equal(hasSufficientSet([["a"], ["b", "c"]], new Set(["b", "c"])), true);
assert.equal(hasSufficientSet([["a"], ["b", "c"]], new Set(["b"])), false);
assert.equal(hasSufficientSet([], new Set(["a"])), false);
```

- [ ] Реализовать helper через `sets.some(set => set.length > 0 && set.every(id => present.has(id)))`. Нельзя проверять лишь пересечение хотя бы с одним ID.
- [ ] Добавить полный контекст, удаление избыточного источника, разрушение всех sufficient sets, нерелевантное добавление, перестановку и тот же порядок повторно. Удаление поддержки не означает contradicted; при оставшемся опровержении эталон может стать contradicted, при конфликте — unknown.
- [ ] Для конкретных пар с отрицанием/сменой субъекта проверять вручную заданный новый gold; не требовать от validator автоматически понимать такие изменения. Для selector сравнивать выбранные ID с размеченными requiredCheckIds и считать охват областей, не семантическую полноту проверки. В текущем runtime нет отдельного claim extractor: полноту извлечения отметить N/A, не 100%. Любой будущий прототип извлечения оценивается по gold spans, сущностям, отрицанию и времени до его интеграции.
- [ ] Добавить output-строку `scenarioId`, `variantId`, `repeat`, `gold`, `predicted`, `policyAction`, `transportStatus`, `sourceIds`, `taskVersion`, `inputHash`, `latencyMs`, `usage`. Предсказание unknown, abstain и unavailable сохранять отдельно.
- [ ] Тестировать метрики на ручной таблице: 2 принятых текста, из них 1 ошибочный; 4 плохих текста, из них 1 принят. Должны получиться acceptedError=1/2 и badTextMissRate=1/4, не одинаковые числа. Нулевой знаменатель возвращает null.
- [ ] Отчёт группировать по базовым сценариям и семействам. Для перестановок показывать disagreement с перестановкой и без неё; не приписывать все различия порядку.

**Deliverable:** детерминированный набор преобразований и проверяемые знаменатели без расходов API. Повторить команду Task 1.

## Task 3: Одинаковый verifier, разные источники

**Files:** Create `scripts/eval-grounded-narrative.ts`; Extend `tests/grounded-evaluation.test.ts`; read/reuse `src/lib/narrative-verifier.ts`, `src/lib/jev-tasks.ts`.

**Interfaces:** Runner принимает `--live`, `--split development|calibration|holdout`, `--max-calls N`, `--max-cost-usd USD`. По умолчанию dry-run; экспортировать `buildGroundedRequest(c: GroundedCase): { state: Record<string, unknown>; selection: NarrativeCheckSelection }` для тестов. Из claim.gold ничего не выводить в questions.

- [ ] Написать тесты: обычный и oracle-режим вызывают один и тот же transport; oracle не подменяет ответ; timeout/invalid response дают unavailable; replay требует тот же body hash.
- [ ] Сформировать узкую Choice-рубрику с действующими метками consistent/contradicts/insufficient и отдельным ID на claim. При анализе отображать consistent→supported, contradicts→contradicted, insufficient→unknown; no_claim оценивается отдельно, не выдаётся как факт. Зафиксировать новую экспериментальную версию; не заменять `NARRATIVE_TASK_VERSION` runtime.
- [ ] Запускать baseline на неизменённых serialized inputs, narrow-real на найденных основаниях и narrow-oracle на размеченном наборе. Для narrow-real/narrow-oracle неизменны claims, questions, task version, модель, параметры и лимит контекста; меняются только источники. Тест сравнивает запросы после удаления поля sources и требует равенства. Разницу runtime-baseline и narrow-oracle нельзя целиком приписывать retrieval. Для случая без доступного baseline явно писать `baseline_missing`; не считать его победой нового варианта.
- [ ] До live требовать положительные явные лимиты вызовов/стоимости и актуальную оценку верхней цены следующего запроса; при неизвестной цене не начинать платный прогон. Остановиться до превышения лимита, при ошибке протокола или отсутствии usage-cost. Не писать ключи/сырые ошибки. Сохранять неполный отчёт со stopReason; retries=0 в первом проходе.
- [ ] Разделить калибровочные и контрольные шаблоны; существующие 80+48 запросов использовать только как development. После просмотра holdout изменение рубрики требует нового holdout.
- [ ] Проверить dry-run и replay до живого запуска. В live с `.env.eval` не импортировать test-environment, который удаляет ключи; сам runner не импортирует подключение к БД.

```powershell
node --import tsx scripts/eval-grounded-narrative.ts --split development
node --env-file=.env.eval --import tsx scripts/eval-grounded-narrative.ts --live --split development --max-calls 120 --max-cost-usd 1
```

Лимиты в примере — верхний инженерный бюджет первого запуска, не прогноз цены и не требуемое число вызовов. Разрешение пользователя на синтетические Jev-тесты уже есть; отдельные реальные кампании в этот план не входят.

## Task 4: Реальный поиск и финальный результат хода

**Files:** Extend `tests/narrative-turn-integration.test.ts`, `scripts/eval-narrative-serialized.ts`; Create `tests/grounded-retrieval.test.ts`. Reuse `tests/helpers/memory-search-db.ts`, `src/lib/narrative-evidence.ts`, `src/lib/memory-search.ts`.

- [ ] В PGlite задать одну целевую и одну чужую кампанию; одинаковое имя NPC в обеих, поправку обязательства и старую версию. Исполнить настоящие SQL builders: чужие и появившиеся после currentTurn источники недопустимы; старая версия сохраняется как основание исторического atTurn, но не текущего состояния. Raw retrieval может вернуть обе версии; проверять правильность их интерпретации, не требовать от SQL семантического verdict. Управляемые векторы проверяют код, не семантическое качество embeddings.
- [ ] Измерять для каждого канала recall@5/@8 и наличие хотя бы одного полного sufficient set. Для unknown без эталонных источников recall=null; не награждать выдачу случайных фрагментов.
- [ ] Для семантического retrieval подготовить отдельный синтетический текстовый корпус с сохранёнными embeddings, именем модели, размерностью и хешами. Создание embeddings реальным провайдером требует разрешения именно на этот провайдер; без него помечать semantic benchmark pending и выполнять PGlite/replay-часть. Разрешение Jev не считать разрешением оплачивать любую модель.
- [ ] Дополнить существующую 20-ходовую цепочку бытовой free/narrative сценой и preset/d20 сценой: изменённая договорённость, неудавшееся действие, исправление черновика, неизвестное NPC сведение. Для каждого хода фиксировать состояние до/после и окончательный narration hash.
- [ ] Утверждения тестов: память соответствует принятому состоянию; rejected claim не появляется в следующих контекстах; repair перепроверен; displayed applied changes не отражают отвергнутую операцию; lease-expired commit отвергается. Не дублировать уже существующие проверки без нового случая.
- [ ] Сохранять в captures initialDraft/finalDraft, verification/review/repair, committed changes и независимый gold. Оценивать итоговый текст отдельно от исходного; подсчитывать исправленные и внесённые repair ошибки.
- [ ] Зарегистрировать captureId, pre/post-state и идентификаторы accepted/rejected operations в оценочном sidecar. `transitionRef` проверяется по этому registry; несовпадение captureId/operationIds отвергается. Разрешённое правило дара и фактически принятый дар — разные основания. Sidecar не добавляет поля в production-схему и portable JSON.

```powershell
node --import tsx --import ./tests/helpers/test-environment.ts --test --test-concurrency=1 tests/grounded-retrieval.test.ts tests/narrative-turn-integration.test.ts
npm run typecheck
npm run lint
npm run check:docs
```

## Task 5: Решение по результатам

- [ ] Сохранить отчёт с corpus/task/model hashes, независимостью разметки, режимом запуска, числами ошибок, abstention, coverage, p50/p95, расходом, неполными прогонами и различиями между retrieval/reader/repair. Статистический вывод о выигрышах делать только на непересекающемся holdout; доверительные интервалы строить по сценариям, не по отдельным связанным claims.
- [ ] Не уменьшать пороги ради coverage. Если oracle существенно лучше реального retrieval, следующий production-план адресует источники. Если ошибки остаются на oracle, менять рубрику/читателя. Если пропущены claims, адресовать полноту проверки. Если final хуже initial, исправлять repair/commit-путь.
- [ ] Если эффект неопределён, записать «выигрыш не установлен», не «методы эквивалентны». Два независимых человека должны проверить контрольные эталоны до заявления о готовности; без них диагностический эксперимент всё равно полезен для локализации ошибок.
- [ ] Обновить JEV-3c, EVAL-2/3 и QUAL-1 в основном roadmap, сохранив ID. Закрывать только выполненные пункты. Production rollout не является результатом этого плана.
