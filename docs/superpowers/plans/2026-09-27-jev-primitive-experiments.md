# Jev Score and Noul Utility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Установить, даёт ли Score полезнее выбранный контекст, а Noul — обнаружение пропущенных проверок при приемлемых расходах, по сравнению с текущим кодом и Choice.

**Architecture:** Сначала отдельные эксперименты в scripts на общем размеченном корпусе. Существующие `parsePrimitiveAnswers` и primitive runners переиспользуются; игровой ход и общий Choice transport не расширяются до доказанной потребности.

**Tech Stack:** TypeScript, node:test, tsx, существующий OpenRouter Jev evaluator, сохранённые synthetic/replay fixtures.

**Spec:** [Исследовательская спецификация](../../narrative-research-synthesis-2026-09-27.md). Зависимость для доказательного сравнения: [корпус и контроль источников](2026-09-27-grounded-narrative-evaluation.md), Tasks 1–3; для живого семантического retrieval также Task 4. Прототипы с replay можно писать независимо.

## Global Constraints

- User-facing copy is Russian. Сохранять preset/free и d20/rules-light/narrative.
- Изменяются оценочные scripts/tests; production-пороги, fallback и обязательные проверки сохраняются.
- Нет обращения к пользовательской БД. `.env.eval` разрешён только явному live-runner, не unit-тестам.
- Синтетические метки без независимой проверки обозначаются diagnostic; они не устанавливают production-готовность.
- Negative Noul не отключает обязательные проверки; Score не отбрасывает обязательный контекст и не разрешает изменение канона.

## Task 1: Score полезности дополнительного источника

**Files:** Modify `scripts/jev-utility-fixtures.ts`, `scripts/eval-jev-utility.ts`, `scripts/jev-evaluation.ts`; Create `tests/jev-utility-experiments.test.ts`. Existing parsers/tests сохраняют прежнюю совместимость.

**Interfaces:** Create `scripts/jev-utility-experiments.ts` with `EvidenceCandidate = { id: string; text: string; originalRank: number; pinned: boolean }`, `rankOptionalEvidence(candidates: readonly EvidenceCandidate[], scores: ReadonlyMap<string, number>, k: number): string[]` and `evidenceUtilityCriteria: readonly string[]`.

- [ ] До реализации написать тест: pinned `a` остаётся первым даже при score=0; optional `b` с score=2 выше `c` с score=1; при равных score порядок originalRank; неизвестный candidate ID и nonfinite score отвергаются; отсутствующий/ошибочный ответ возвращает исходный optional-порядок целиком.
- [ ] Взять одну ось и точные уровни:

```ts
export const evidenceUtilityCriteria = [
  "Фрагмент не помогает установить или опровергнуть указанное утверждение и не уточняет нужные сущность, время или правило.",
  "Фрагмент уточняет нужную сущность, время или правило, но сам по себе не даёт прямого основания подтвердить либо опровергнуть утверждение.",
  "Фрагмент содержит прямое подтверждающее или опровергающее основание для указанного утверждения с подходящими сущностью и временем.",
] as const;
```

- [ ] Формулировать вопрос про конкретный claim, передавать его область/время/сущность. Сохранять probabilities и confidence наряду со score. Не сравнивать raw scores разных рубрик. Не подавать ожидаемую полярность источника в request.
- [ ] `rankOptionalEvidence` не изменяет входной массив: сначала pinned в исходном порядке, затем до k optional. k — только optional-бюджет. При неизвестных ID, нечисловом score или отрицательном k бросать `invalid_ranking`; при неполном наборе ответов fallback на исходный порядок. Pinned плюс optional затем проходят прежний бюджет контекста; переполнение обязательного контекста фиксируется явно, не скрывается.
- [ ] На одинаковых кандидатах сравнить текущий ранжировщик, Score и Choice с теми же тремя описанными категориями. Отдельно сравнить выигрыш получения кандидатов и их перестановки: reranker не может вернуть источник, отсутствующий в кандидатах.
- [ ] Считать complete-evidence-set recall@5/@8, поддержку и опровержение раздельно, конечный false accept/false reject, p50/p95 и стоимость. NDCG — вспомогательный показатель; высокий rank сам по себе не означает правильность итогового вердикта.

```powershell
node --import tsx --import ./tests/helpers/test-environment.ts --test tests/jev-utility-experiments.test.ts tests/jev-evaluation.test.ts
```

**Решение:** если Score не улучшает конечный результат относительно текущего baseline и Choice либо улучшает лишь красивую метрику ранжирования, не переносить в runtime. Если доказательный набор мал, заключение — неопределённость, не равенство методов.

## Task 2: Noul как добавочная маршрутизация

**Files:** Extend `scripts/jev-utility-experiments.ts`, `scripts/jev-utility-fixtures.ts`, `tests/jev-utility-experiments.test.ts`; read existing `src/lib/narrative-policy.ts` без изменения runtime.

**Interfaces:** `AdditionalCheck = "history" | "npc_knowledge" | "agency"`; `mergeChecks(required: readonly AdditionalCheck[], candidates: Partial<Record<AdditionalCheck, number>>, threshold: number): AdditionalCheck[]`.

- [ ] Написать тесты:

```ts
assert.deepEqual(mergeChecks(["history"], { history: 0.01 }, 0.9), ["history"]);
assert.deepEqual(mergeChecks([], { npc_knowledge: 0.95 }, 0.9), ["npc_knowledge"]);
assert.deepEqual(mergeChecks([], {}, 0.9), []);
assert.throws(() => mergeChecks([], { agency: NaN }, 0.9));
```

- [ ] Реализовать объединение существующего набора с категориями выше порога; валидировать диапазон 0..1, включая threshold. Отсутствующий ответ не снимает существующий check. Значение 0.9 в тесте иллюстрирует контракт, не готовый production-порог.
- [ ] Использовать вопрос, который не требует знания истины события: «Есть ли в данном тексте утверждение о том, что происходило до текущего хода?»; отдельно «Приписывает ли текст NPC конкретное знание?» и «Приписывает ли текст игроку выбор, которого нет в переданном действии?». Последняя рубрика — кандидат для оценки; её ошибки измерять отдельно от остальных.
- [ ] Сравнить Noul с действующим `selectNarrativeChecks` и тремя бинарными Choice-вопросами на тех же текстах; разметить наличие каждого вида утверждения независимо от его истинности. Считать пропущенные нужные проверки, лишние проверки, конечные ошибки и суммарные дополнительные вызовы.
- [ ] Порог выбирать на calibration по заданному до просмотра holdout допустимому числу лишних проверок; показать всю кривую tradeoff. Любая добавочная проверка сохраняет право вернуть insufficient. Не считать её отсутствие каноническим отрицанием.

**Решение:** если Noul преимущественно повторяет regex/Choice без обнаружения реальных пропусков, завершить эксперимент без runtime-интеграции. Если допроверка обнаруживает ошибки, сначала рассмотреть простое расширение детерминированного selector: модель нужна только там, где более простой вариант не решает задачу.

## Task 3: Пара Noul и литературные рубрики — разные эксперименты

**Files:** Modify `scripts/jev-research-fixtures.ts`, `scripts/eval-jev-research.ts`, `tests/jev-research.test.ts`. Для литературной оценки Create `docs/evaluations/story-human-rubric.md`; не добавлять вызовы в turn.

- [ ] Сохранить dual-Noul конфликт при двух высоких ответах, unknown при отсутствии обоих оснований; дополнить результат separate evidenceUnknown/modelAbstain там, где это можно установить из независимой разметки. Не выводить причину неизвестности только из двух вероятностей.
- [ ] Сравнить Choice и пару Noul на корпусе первого плана с одинаковыми текстами и источниками. Суммировать расходы обоих вопросов и всех retries; не считать их независимыми голосами.
- [ ] Для литературной оценки подготовить три независимые оси: соблюдение явно заданного голоса; понятность связей между событиями; признание действия игрока. Для каждой дать 3–4 описанных уровня и N/A, когда критерий неприменим. Не использовать обязательные напряжение, бой, драму, сложность или неожиданный финал.
- [ ] Пример оси признания действия: «Текст игнорирует или подменяет заявленное действие» / «Текст признаёт действие, но связь с реакцией сцены неясна» / «Текст признаёт действие и понятно описывает исход или причину неопределённости». Неудача броска может получить высший уровень.
- [ ] До платного Score-эксперимента проверить, что люди различают уровни на русских бытовых и необычных сеттингах. Сохранить индивидуальные оценки и разногласия. При неустойчивой разметке уточнять рубрику, не объявлять модельную оценку эталоном.

## Task 4: Отчёт и условный production follow-up

- [ ] Dry-run/replay сначала; live использует бюджетный runner из первого плана, а не неограниченный цикл. Не запускать все комбинации промптов: одна заранее выбранная версия на задачу, затем анализ конкретных ошибок.
- [ ] Зафиксировать task/model/corpus hashes и исходные результаты. Для каждого применения написать отдельное принять/доработать/отложить; универсальный «Score лучше» не допускается.
- [ ] До любого включения зафиксировать максимальный допустимый риск и расходы по конкретной задаче в новом production-плане. Этот исследовательский план не выбирает молча продуктовый компромисс false accept versus false reject.
- [ ] Если выигрыш установлен, новый план обязан содержать typed adapter, cancellation/timeouts/usage, owner/session/version-scoped источники, ограничения контекста, тесты repair/final draft, off/shadow/on и немедленный fallback на прежний путь. Shadow ограничен бюджетом и не является скрытым оплачиваемым вызовом каждого хода.
- [ ] Проверить `npm run typecheck`, `npm run lint`, `npm run check:docs` и focused tests выше; обновить JEV-2/JEV-3d, не закрывая их на основании одного диагностического запуска.
