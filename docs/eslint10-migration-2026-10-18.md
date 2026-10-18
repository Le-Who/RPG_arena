# Переход на ESLint 10 с сохранением Next 16 — 18 октября 2026

> Историческая миграция с сохранением preset через bridge. Следующий этап после аудита реальных React API: [нативные плагины и актуальная политика TSX](react-eslint-native-policy-2026-10-18.md); compat и eslint peer override удалены в рамках этого следующего этапа.

## Решение и границы

ESLint обновлён с 9.39.4 до 10.13.0. Next, eslint-config-next и @next/eslint-plugin-next согласованно обновлены с 16.3.8 до 16.4.2. React 19.2.6 и код приложения сохранены. Node.js: `^20.19.0 || ^22.13.0 || >=24`; локальная проверочная среда — 24.13.0, CI и Docker используют 24.

Актуальные eslint-plugin-react 7.37.5, eslint-plugin-jsx-a11y 6.10.2 и eslint-plugin-import 2.32.0 всё ещё ограничивают upstream peer range ESLint 9. Установленный стек использует проверенный слой совместимости; нативная поддержка ESLint 10 этими тремя upstream-релизами не заявляется. react-hooks 7.1.1 и typescript-eslint 8.70.0 уже допускают ESLint 10.

Next 16.4 добавляет upstream адаптацию Babel scope manager и старых rule contexts. Дополнительно весь исходный Core Web Vitals flat config обёрнут официальным `@eslint/compat` 2.1.1: он восстанавливает SourceCode API, ещё используемые React/import. Все правила, настройки и исключения наследуются из Next; правила не отключались и не переписывались вручную.

## Почему недостаточно изменить номер ESLint

- ESLint 10 с Next 16.3.8 падает до правил: `scopeManager.addGlobals is not a function`. Первые 38 проверок воспроизвели несовместимость.
- Next 16.4.2 исправляет парсер и контекст, однако автоисправления React/import ещё падают на `isSpaceBetweenTokens` и `getTokenOrCommentAfter`: 36/38 проверок прошли, две выявили оставшиеся API-проблемы.
- Отдельный class fixture с `@extends React.Component` и `extends Base` на JSX и TSX доказал тихую потерю `react/no-direct-mutation-state` без official compat: raw Next не выдаёт сообщений, с адаптером выдаёт ошибку. Исправленный вариант через `setState` допускается.

Новый `tests/eslint-toolchain-compat.test.ts` проверяет настоящие диагностические сообщения и автоисправления: React, шесть активных JSX a11y правил, hooks, import, Next, оба парсера и ведущие inline disable comments. Проверки исполняют установленный root config без mock-плагинов.

Typecheck также выявил obsolete поле `fallbackParams` в существующей OAuth fixture. Оно заменено на обязательное `stagedFallbackParams: null`, как в фактическом Next 16.4.2 `createRequestStoreForAPI`. Сохранены настоящий action/cookie store, все проверки PKCE, scoped cookies, replay и отзыва сессии; пять OAuth cases прошли после исправления.

## npm overrides и безопасность цепочки

Обычные npm install/ci выполняются без `--force` и `--legacy-peer-deps`. Три раздельных scoped peer overrides оказались непригодны под npm 11: Arborist помечает общие hoisted зависимости invalid из-за конфликтующих ветвей overrides даже при подходящем semver. Вложенный прежний security override создавал такой же конфликт для is-glob после добавления ESLint 10.

Приняты две общие leaf-записи: `eslint: "$eslint"` и `braces: "$braces"`. Первая заставляет lint-цепочку использовать единственный ESLint 10.13.0. Поскольку она шире трёх peer-исключений, постоянная регрессия проверяет сырые upstream peer ranges всех установленных ESLint-потребителей: разрешены только поддерживающие текущий ESLint пакеты либо три точных проверенных legacy-релиза выше. Также проверяется, что peer resolution не подставил старый ESLint.

Прежний приватный braces depth-патч сохранён без изменений алгоритма. В текущем lockfile у braces по-прежнему ровно один transitive consumer: micromatch 4.0.8 → `^3.0.3` из fast-glob 3.3.1 и Next lint plugin. Новый тест отвергает требования несовместимой braces API. Новые потребители требуют отдельного review. Docker COPY tooling сохранён. [Предыдущее устранение high-уязвимости](eslint-dependency-remediation-2026-10-18.md), [provenance и обслуживание fork](../tooling/braces/README.md).

Сохранены исходные версии, integrity и ABI-метаданные несвязанных optional WASM/platform пакетов, которые npm на Windows переписывал при разрешении дерева. Изменения артефактов ограничены согласованным Next-стеком, ESLint и его зависимостями.

## Проверки

Проверки полной поставки выполняются в отдельной физической копии только repository inputs, без приватных env-файлов и provider credentials. Используется фиктивный loopback DSN с выключенными auto migrations; штатные тесты работают с disposable fixtures/PGlite. Успех локальных проверок не заявляет live качество моделей, реальный PostgreSQL deployment или hosted Linux CI.

| Проверка | Подтверждённый результат |
| --- | --- |
| Focused после окончательной правки fixture | 84/84: 39 новых lint/peer, 40 прежних security/glob, 5 OAuth; exit 0 |
| Чистый npm ci | В основном checkout и физической копии, по 383 установленным пакетам; exit 0 без peer warnings |
| npm ls --all | Согласованное дерево, один ESLint 10.13.0, exit 0 |
| Full / production npm audit | 0 vulnerabilities, exit 0 |
| Typecheck | Exit 0 после замены obsolete Next fixture field |
| Lint | Exit 0, все существующие правила сохранены |
| Build | Штатный Next 16.4.2 Turbopack build, exit 0 |
| Production HTTP smoke | Реальный `next start`: /api/version, manifest и static icon → 200; no-store и отсутствие identity cookie на version endpoint сохранены |
| Минимальные Docker dependency-stage inputs | npm ci и production prune exit 0; Next 16.4.2 доступен, lint dev packages удалены, runtime audit 0 |
| Независимый review | 39/39 повторены; найденные четыре пропущенных SWC libc metadata восстановлены из registry и повторно проверены; открытых findings нет |
| Полный npm test | 1220/1220, exit 0; fail/cancelled/skipped/todo 0; штатный последовательный скрипт, около 16 минут |
| Финальный check:docs | 91 файл / 369 локальных ссылок, exit 0; проверены актуальные npm commands и migration ledger |

Registry `libc` восстановлен и для четырёх обновлённых Linux SWC артефактов: GNU → glibc, musl → musl; сверены integrity. Docker CLI отсутствует, Linux image build не заявляется. Первые полные прогоны были остановлены при исправлении fixture либо прерваны исчерпанием памяти хоста без итогового результата. Они не считаются успешным полным набором. Финальный штатный npm test повторён отдельно от тяжёлых параллельных процессов и прошёл полностью: 1220/1220.

После полного прогона повторены full/runtime audit и npm ls --all: exit 0. Все 522 non-document inputs побайтово совпадают между основным checkout и физической копией и сохранили зафиксированные до проверок SHA-256. Сверка эффективного конфига также повторена на окончательной копии.

Сверка эффективного ESLint 9/10 config для JSX/TSX/TS/MJS: по 67 записей, из них 62 активных; совпали уровни и параметры всех правил, набор плагинов, globals, parser options, linter options и 10 ignore probes. Next 16.4 использует абсолютные resolver paths: сопоставлены те же node/TypeScript resolvers и параметры. Babel parser version изменился 16.3.8 → 16.4.2; TypeScript parser 8.70.0 и ECMAScript 2026 сохранены.

Raw evidence: `output/eslint10-migration-2026-10-18/`. [План](superpowers/plans/2026-10-18-eslint10-migration.md).

## Когда убирать совместимость

При обновлении трёх legacy-плагинов сначала проверить нативный ESLint 10 peer range и новые API. После прохождения этих регрессий и полного npm ls/audit убрать `eslint` override и, когда он больше не нужен для SourceCode, `@eslint/compat` вместе с обёрткой конфига. Существующие тесты должны проходить без отключения правил.

Проверка следующего этапа от того же дня: [нативные React/a11y/import кандидаты](native-eslint-plugins-evaluation-2026-10-18.md) установлены и сравнены на исполняемых fixtures. React пока теряет часть действующих диагностик, поэтому условие удаления bridge/peer override ещё не выполнено. A11y/import готовы для протестированного среза; отдельная частичная миграция сейчас не принята по соотношению пользы и сопровождения.

Braces fork удаляется отдельно, когда upstream цепочка исправлена/удалена и проходит прежние grammar/depth/Next filesystem регрессии. Нулевой registry audit сам по себе не оценивает приватный исходный код; доказательства depth-патча остаются в предыдущем отчёте. Новые upstream braces advisory нужно отслеживать отдельно от приватного имени пакета.

## Первичные источники

- [Поддержка версий ESLint](https://eslint.org/version-support/).
- [Миграция на ESLint 10: Node, contexts, SourceCode и ScopeManager](https://eslint.org/docs/latest/use/migrate-to-10.0.0).
- [Next ESLint: поддержка ESLint 10 с 16.4.0](https://nextjs.org/docs/app/api-reference/config/eslint).
- [Next 16.4.2 parser](https://github.com/vercel/next.js/blob/v16.4.2/packages/eslint-config-next/src/parser.ts) и [rule context bridge](https://github.com/vercel/next.js/blob/v16.4.2/packages/eslint-config-next/src/rule-context.ts).
- [Официальный compat 2.1.1](https://github.com/eslint/rewrite/tree/compat-v2.1.1/packages/compat).
- [npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides) и [Arborist override ancestry validation](https://github.com/npm/cli/blob/latest/workspaces/arborist/lib/edge.js).
