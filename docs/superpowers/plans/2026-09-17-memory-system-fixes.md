# Memory System Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить 9 выявленных дефектов в системе памяти RPG Arena — от критичных race-condition'ов до мусорных нод и устаревших хардкодов.

**Architecture:** Правки охватывают три слоя: серверные маршруты (`act/route.ts`, `sessions/route.ts`, `sessions/[id]/route.ts`), библиотеку памяти (`lib/memory.ts`) и React-клиент (`play/[id]/page.tsx`). Каждый таск независим и даёт тестируемый результат без блокировки соседних.

**Tech Stack:** Next.js 14 App Router, Drizzle ORM, PostgreSQL, React 18, TypeScript strict mode.

**Spec:** `docs/superpowers/plans/2026-09-17-memory-system-fixes.md` (этот файл).

## Global Constraints

- TypeScript strict: `npx tsc --noEmit` должен выдавать 0 ошибок после каждого таска.
- Никаких новых зависимостей.
- Офлайн-режим (без Gemini API ключей) должен продолжать работать без изменений.
- Порядок: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9. Таски 3-9 независимы.

---

## Карта дефектов -> тасков

| Дефект | Таск | Серьёзность |
|--------|------|-------------|
| Stale closure в авто-компакции (compacting state vs ref) | Task 1 | КРИТИЧНО |
| memoryDigest не передаётся в resolution-промпт | Task 2 | КРИТИЧНО |
| salience: 60 hardcoded при вставке эвристических нод | Task 3 | Серьёзно |
| limit(200) ходов — тяжёлый payload в UI | Task 4 | Серьёзно |
| tokensEstimate seed-нод — хардкод вместо estimateTokens() | Task 5 | Серьёзно |
| Dice-ходы раздувают turnCount -> ранняя компакция | Task 6 | Серьёзно |
| procedural-слой никогда не обновляется | Task 7 | Серьёзно |
| «золото» как keyword порождает мусорные item-ноды | Task 8 | Умеренно |
| Chronicle-нода заголовком отстаёт на 1 главу | Task 9 | Умеренно |

---

## Task 1: Устранение stale closure при авто-компакции

**Проблема:** В page.tsx функция act() проверяет !compacting (React state) — stale closure.
compactingRef.current уже существует в коде (строки 97-98), но не используется там, где нужно.
Итог: при быстром завершении act() и needsCompaction = true возможен двойной вызов /compact.

**Файлы:**
- Modify: src/app/play/[id]/page.tsx (~строка 153)

**Interfaces:**
- Consumes: compactingRef.current: boolean — строки 97-98
- Produces: надёжная защита от двойного запуска компакции через ref

- [ ] **Step 1: Найди проблемную строку**

  Файл src/app/play/[id]/page.tsx, строка ~153:
  ```
  if (j.needsCompaction && !compacting) {
  ```

- [ ] **Step 2: Замени stale-state на ref**

  Было:
  ```
  if (j.needsCompaction && !compacting) {
  ```
  Стало:
  ```
  if (j.needsCompaction && !compactingRef.current) {
  ```

- [ ] **Step 3: Проверь весь блок авто-компакции (строки ~149-167)**

  Убедись:
  - compactingRef.current проверяется ДО setCompacting(true)
  - setCompacting(false) вызывается в finally
  - Кнопка disabled={compacting} использует state (правильно для UI)
  - Polling load() использует compactingRef.current (строка ~102 — уже сделано)

- [ ] **Step 4: TypeScript check**

  ```
  npx tsc --noEmit
  ```
  Ожидаемый результат: 0 ошибок.

- [ ] **Step 5: Commit**

  ```
  git add src/app/play/[id]/page.tsx
  git commit -m "fix(ui): use compactingRef.current to prevent stale-closure double-compaction"
  ```

---

## Task 2: Передача memoryDigest в resolution-промпт

**Проблема:** При isCustom = true (свободное действие) user-сообщение для Gemini содержит
recentTurns и playerAction, но НЕ memoryDigest. Модель не видит структурированную память
о мире (NPC, квесты, артефакты) и может противоречить канону.

**Файлы:**
- Modify: src/app/api/sessions/[id]/act/route.ts (строки ~199-201)

**Interfaces:**
- Consumes: memoryDigest: string — уже вычислен выше в POST handler (строки ~144-155)
- Produces: обогащённый user-промпт для resolution с дайджестом памяти

- [ ] **Step 1: Найди проблемный блок**

  Строки ~199-201 в act/route.ts:
  ```
  const user = isCustom
    ? `Ситуация:\n${recentTurns}\nДействие игрока (free-form): ${playerAction}\nПерсонаж: ${charLine}\nЛокация: ${world.currentLocation}`
    : `Ход ${nextTurn}. Персонаж: ${charLine}. Игрок выбрал: «${playerAction}». Опиши последствия и предоставь 3 новых варианта.`;
  ```

- [ ] **Step 2: Добавь memoryDigest в resolution user-промпт**

  Замени весь блок const user = ... на:
  ```
  const user = isCustom
    ? `ПАМЯТЬ КАНА (соблюдай строго):\n${memoryDigest}\n\nПоследние события:\n${recentTurns}\n\nДействие игрока (free-form): ${playerAction}\nПерсонаж: ${charLine}\nЛокация: ${world.currentLocation}`
    : `Ход ${nextTurn}. Персонаж: ${charLine}. Игрок выбрал: «${playerAction}». Опиши последствия и предоставь 3 новых варианта.`;
  ```

  promptTokens = estimateTokens(system + user) пересчитывается автоматически сразу ниже.

- [ ] **Step 3: Проверь размер промпта**

  memoryDigest ограничен hardCap в assembleMemoryDigest:
  - lite: 8 000 символов ≈ 2 200 токенов
  - flash: 14 000 символов ≈ 3 800 токенов
  maxTokens: 1400 для resolution-вызова (ответ модели) не изменяется.

- [ ] **Step 4: TypeScript check**

  ```
  npx tsc --noEmit
  ```

- [ ] **Step 5: Commit**

  ```
  git add src/app/api/sessions/[id]/act/route.ts
  git commit -m "fix(act): pass memoryDigest into resolution user prompt to preserve canon"
  ```

---

## Task 3: Динамический salience при вставке эвристических нод

**Проблема:** Все эвристические ноды в act/route.ts получают salience: 60 независимо от importance.
Нода со смертью (importance: 82) и нода с предметом (importance: 62) неотличимы по salience.
Это снижает точность ранжирования в assembleMemoryDigest.

**Файлы:**
- Modify: src/app/api/sessions/[id]/act/route.ts (строки ~395-408)

- [ ] **Step 1: Найди блок вставки**

  Строки ~403 в act/route.ts:
  ```
  salience: 60,
  ```

- [ ] **Step 2: Замени хардкод**

  Было:
  ```
  salience: 60,
  ```
  Стало:
  ```
  salience: Math.min(95, Math.max(45, c.importance)),
  ```

  Обоснование: Math.max(45) — минимум для эвристических нод (менее надёжные, чем компактированные,
  поэтому 45 а не 50 как в compact/route.ts:133). Math.min(95) — cap совпадает с компакцией.

- [ ] **Step 3: TypeScript check + commit**

  ```
  npx tsc --noEmit
  git add src/app/api/sessions/[id]/act/route.ts
  git commit -m "fix(act): derive salience from importance instead of hardcoded 60"
  ```

---

## Task 4: Пагинация ходов в GET /api/sessions/[id]

**Проблема:** limit(200) отдаёт весь журнал в JSON. При dice-ходах (+2 к счётчику)
70 реальных действий = 140+ записей = ~400-600KB payload при каждом polling (каждые 15с).

**Файлы:**
- Modify: src/app/api/sessions/[id]/route.ts (строка 12)

**ВНИМАНИЕ:** Проверь перед правкой, что page.tsx не использует turns.length для бизнес-логики.
chapter, HP, turnCount читаются из session.worldState и session.turnCount — не из массива ходов.

- [ ] **Step 1: Проверь использование data.turns в page.tsx**

  Найди все data.turns в src/app/play/[id]/page.tsx. Убедись:
  - Только .map() для рендера лога
  - lastNarrator ищется через .reverse().find() — на усечённом массиве правильно
  - Нет .length-агрегаций для бизнес-логики

- [ ] **Step 2: Замени запрос**

  Файл src/app/api/sessions/[id]/route.ts, строка 12.
  
  Было:
  ```
  const turns = await db.select().from(gameTurns).where(eq(gameTurns.sessionId, id)).orderBy(asc(gameTurns.turnNumber)).limit(200);
  ```
  
  Стало:
  ```
  // Последние 60 записей (~30 игровых ходов с dice-дублями).
  const turnsDesc = await db
    .select()
    .from(gameTurns)
    .where(eq(gameTurns.sessionId, id))
    .orderBy(desc(gameTurns.turnNumber))
    .limit(60);
  const turns = turnsDesc.reverse(); // восстанавливаем хронологический порядок
  ```
  
  Убедись что `desc` есть в импорте строки 4 (добавь если нет).

- [ ] **Step 3: TypeScript check + commit**

  ```
  npx tsc --noEmit
  git add src/app/api/sessions/[id]/route.ts
  git commit -m "fix(api): limit turns to last 60 entries to reduce polling payload size"
  ```

---

## Task 5: Реальный tokensEstimate для seed-нод

**Проблема:** Три стартовые ноды в sessions/route.ts используют хардкод tokensEstimate: 80/90/50.
Реальный контент включает backstory (до 800 символов), статы, навыки — расхождение кратное.

**Файлы:**
- Modify: src/app/api/sessions/route.ts (строки ~155-193)

- [ ] **Step 1: Объяви переменные контента перед insert**

  Добавь перед await db.insert(memoryNodes)...:
  ```
  const chronicleContent = `Мир: ${worldName}. Квест: ${mainQuest}. Герой ${character.name} (${character.archetype}) начинает в «${startLocation}». Тон: ${tone}.`;
  const semanticContent = `${character.archetype}. ${character.backstory} Статы: ${Object.entries(character.stats).map(([k, v]) => `${k} ${v}`).join(", ")}. Навыки: ${character.skills.join(", ")}.`;
  const proceduralContent = "Проверки d20+мод vs DC. Крит 20 — триумф, 1 — провал. HP 40, урон снижает, зелья лечат. Выбор игрока или своё действие.";
  ```

- [ ] **Step 2: Используй переменные и estimateTokens() в insert**

  Замени весь блок db.insert(memoryNodes).values([...]) (строки ~156-193) на:
  ```
  await db.insert(memoryNodes).values([
    {
      sessionId: session.id,
      layer: "chronicle",
      category: "quest",
      title: "Глава 1: Начало",
      content: chronicleContent,
      importance: 95,
      salience: 90,
      tokensEstimate: estimateTokens(chronicleContent),
      turnFrom: 0,
      turnTo: 1,
    },
    {
      sessionId: session.id,
      layer: "semantic",
      category: "character",
      title: `Герой: ${character.name}`,
      content: semanticContent,
      importance: 90,
      salience: 85,
      tokensEstimate: estimateTokens(semanticContent),
      turnFrom: 0,
      turnTo: 1,
    },
    {
      sessionId: session.id,
      layer: "procedural",
      category: "rule",
      title: "Правила d20",
      content: proceduralContent,
      importance: 60,
      salience: 40,
      tokensEstimate: estimateTokens(proceduralContent),
      turnFrom: 0,
      turnTo: 1,
    },
  ]);
  ```

- [ ] **Step 3: TypeScript check + commit**

  ```
  npx tsc --noEmit
  git add src/app/api/sessions/route.ts
  git commit -m "fix(sessions): use estimateTokens() for seed memory nodes instead of hardcoded values"
  ```

---

## Task 6: Корректный счётчик shouldCompact с учётом dice-ходов

**Проблема:** session.turnCount прыгает на +2 при dice-броске. shouldCompact сравнивает
nextTurn - lastCompactTurn >= 24, но через 12 dice-ходов счётчик уже +24, хотя игрок
сделал только 12 реальных действий. Компакция срабатывает вдвое чаще нужного.

**Решение:** Считать реальные player-ходы (role = "player") через SQL count после lastCompactTurn
без изменения схемы БД.

**Файлы:**
- Modify: src/app/api/sessions/[id]/act/route.ts (раздел shouldCompact, ~строки 428-431)
- Modify: src/lib/memory.ts (только комментарий к shouldCompact)

- [ ] **Step 1: Добавь count, and, gt в импорт drizzle-orm**

  Файл src/app/api/sessions/[id]/act/route.ts, строка 4:
  ```
  import { and, count, desc, eq, gt } from "drizzle-orm";
  ```
  (Добавь только те, которых нет в текущем импорте)

- [ ] **Step 2: Добавь SQL-запрос подсчёта**

  После блока вставки chronicle-ноды (~строка 424) и ДО строки shouldCompact добавь:
  ```
  // Считаем только player-ходы (role = "player") после lastCompactTurn.
  // Dice-записи (role = "dice") не являются действиями игрока.
  const playerCountResult = await db
    .select({ c: count() })
    .from(gameTurns)
    .where(
      and(
        eq(gameTurns.sessionId, id),
        eq(gameTurns.role, "player"),
        gt(gameTurns.turnNumber, lastCompactTurn),
      ),
    );
  const playerTurnsSinceCompact = playerCountResult[0]?.c ?? 0;
  ```

- [ ] **Step 3: Обнови вызов shouldCompact**

  Было:
  ```
  const needsCompaction = shouldCompact(nextTurn, lastCompactTurn, workingTokensEstimate, workingBudget);
  ```
  Стало:
  ```
  // playerTurnsSinceCompact — число реальных действий игрока с последней компакции.
  // Второй аргумент = 0: lastCompactTurn уже учтён в SQL-фильтре выше.
  const needsCompaction = shouldCompact(playerTurnsSinceCompact, 0, workingTokensEstimate, workingBudget);
  ```

- [ ] **Step 4: Обнови JSDoc в shouldCompact (lib/memory.ts)**

  Замени комментарий перед export function shouldCompact(...) (~строка 201):
  ```
  /**
   * Когда пора компактить:
   *   - прошло >= 24 реальных действий игрока с последней компакции
   *   - ИЛИ рабочая память превысила порог workingBudget
   *
   * ВАЖНО: первый аргумент `turnCount` должен быть числом РЕАЛЬНЫХ действий игрока
   * (role = "player") с момента последней компакции, а НЕ session.turnCount.
   * Dice-записи (+2 к turnNumber) не учитываются.
   * Второй аргумент `lastCompactTurn` = 0, т.к. SQL уже выполнил отсечение.
   */
  ```

- [ ] **Step 5: TypeScript check + commit**

  ```
  npx tsc --noEmit
  git add src/app/api/sessions/[id]/act/route.ts src/lib/memory.ts
  git commit -m "fix(compact): count only player turns (not dice entries) for compaction threshold"
  ```

---

## Task 7: Обновление procedural-ноды при level-up

**Проблема:** procedural-нода создаётся один раз при старте (sessions/route.ts) и никогда
не обновляется. После level-up навыки, maxHp и черты меняются — промпт этого не видит.

**Решение:** При leveled = true в act/route.ts вставить новую procedural-ноду (importance: 75).
Старая (importance: 60) уступит ей место в топ-60 — удалять не нужно.

**Файлы:**
- Modify: src/app/api/sessions/[id]/act/route.ts (после chronicle-блока, ~строка 424)

- [ ] **Step 1: Вставь блок после chronicle**

  После строк ~410-424 (if (isChapterBoundary) { ... }) добавь:
  ```
  // При level-up вставляем обновлённую procedural-ноду.
  // importance: 75 > стартовой (60) — гарантирует попадание в топ-60.
  if (leveled) {
    const newMaxHp = character.maxHp + 5;
    const proceduralContent = `Уровень ${newLevel}. Статы: ${Object.entries(character.stats).map(([k, v]) => `${k}:${v}`).join(" ")}. Навыки: ${character.skills.join(", ")}. Черты: ${(character.traits ?? []).join(", ")}. HP: ${newMaxHp}/${newMaxHp}.`;
    await db.insert(memoryNodes).values({
      sessionId: id,
      layer: "procedural",
      category: "rule",
      title: `Уровень ${newLevel}: способности персонажа`,
      content: proceduralContent,
      importance: 75,
      salience: 70,
      tokensEstimate: estimateTokens(proceduralContent),
      turnFrom: nextTurn,
      turnTo: nextTurn,
    });
  }
  ```

  Пояснение: character.maxHp здесь — значение ДО обновления. newMaxHp = character.maxHp + 5
  совпадает с логикой строки ~323 (leveled ? character.maxHp + 5 : character.maxHp).

- [ ] **Step 2: TypeScript check + commit**

  ```
  npx tsc --noEmit
  git add src/app/api/sessions/[id]/act/route.ts
  git commit -m "fix(act): insert updated procedural memory node on level-up"
  ```

---

## Task 8: Исключить «золото» из item-keywords

**Проблема:** «Золото» появляется почти в каждом успешном ходу. Каждое упоминание создаёт
semantic/item ноду «Предмет: золото». После 50 ходов — десятки мусорных нод, вытесняющих
ценную память. Баланс золота уже отслеживается через character.gold в charLine.

**Файлы:**
- Modify: src/lib/memory.ts (~строка 100)

- [ ] **Step 1: Найди и замени массив**

  Было:
  ```
  const itemKeywords = ["клинок", "меч", "кинжал", "лук", "щит", "амулет", "зелье", "свиток", "кольцо", "артефакт", "ключ", "карта", "золото"];
  ```
  Стало:
  ```
  // «золото» исключено: встречается в каждом ходу, не является конкретным предметом.
  // Баланс золота всегда в промпте через charLine (character.gold).
  const itemKeywords = [
    "клинок", "меч", "кинжал", "лук", "щит",
    "амулет", "зелье", "свиток", "кольцо", "артефакт",
    "ключ", "карта", "реликвия", "посох",
  ];
  ```

- [ ] **Step 2: Убедись, что cap max 2 нод сохранён**

  Строка ~114: if (foundItems.size >= 2) break; — без изменений.

- [ ] **Step 3: TypeScript check + commit**

  ```
  npx tsc --noEmit
  git add src/lib/memory.ts
  git commit -m "fix(memory): remove 'золото' from item keywords to prevent spam nodes"
  ```

---

## Task 9: Корректный заголовок chronicle-ноды

**Проблема:** Chronicle-нода создаётся при isChapterBoundary = true, но title использует
world.chapter — значение ДО инкремента. Сессия переходит в главу N+1, а нода называется
«Глава N: рубеж» вместо «Глава N завершена».

**Файлы:**
- Modify: src/app/api/sessions/[id]/act/route.ts (~строки 416-417)

- [ ] **Step 1: Найди и замени title и content**

  Внутри if (isChapterBoundary) { ... } (~строки 411-424):
  
  Было:
  ```
  title: `Глава ${world.chapter}: рубеж на ходе ${nextTurn}`,
  content: narration.slice(0, 500),
  ```
  Стало:
  ```
  title: `Глава ${world.chapter} завершена (ход ${nextTurn})`,
  content: `[Завершение главы ${world.chapter}] ${narration.slice(0, 460)}`,
  ```
  
  Длина content остаётся <=500 символов (460 + ~30 символов префикса).

- [ ] **Step 2: TypeScript check + commit**

  ```
  npx tsc --noEmit
  git add src/app/api/sessions/[id]/act/route.ts
  git commit -m "fix(act): chronicle node title and content reflect completed chapter, not upcoming"
  ```

---

## Verification Plan

### Финальная проверка

- [ ] npx tsc --noEmit -> 0 ошибок
- [ ] npx next lint -> 0 ошибок (или только pre-existing warnings)
- [ ] npx next build -> успешно

### Функциональные проверки (ручные)

| Сценарий | Ожидаемое поведение |
|----------|---------------------|
| Быстро отправить 2 хода подряд | Второй блокируется; авто-компакция не запускается дважды |
| Свободное действие (custom) с именем NPC | Модель не противоречит фактам из memoryDigest |
| 25 player-ходов (часть с dice) | Компакция срабатывает через 24 player-хода, не раньше |
| Набрать уровень | В Memory-вкладке появляется procedural-нода с новым уровнем |
| Нарратор упоминает «золото» | НЕ создаётся semantic/item нода «Предмет: золото» |
| Ход 15 (глава 1->2) | Chronicle-нода: «Глава 1 завершена (ход 15)» |
| Кампания 70+ ходов | UI загружает последние ~60 записей, не зависает |
| Создать новую сессию | Seed-ноды имеют реальный tokensEstimate, не хардкод |

### Регрессионные сценарии

- [ ] Создание сессии (preset + custom) — без ошибок
- [ ] Офлайн-режим (без API ключей) — все 9 тасков прозрачны для офлайна
- [ ] Ручная компакция — не дублируется, UI обновляется после
