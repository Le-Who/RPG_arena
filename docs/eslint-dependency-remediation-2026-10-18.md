# Исправление high-уязвимостей ESLint — 18 октября 2026

## Результат и область

Пять связанных high-записей из первоначального [legacy-аудита](legacy-cleanup-audit-2026-10-18.md) сведены к одному источнику: [GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), переполнению стека в рекурсивных обходах `braces <=3.0.3`. Upstream patched release на момент проверки отсутствует.

Исправление сохраняет Next, eslint-config-next и Next plugin на **16.3.8**, ESLint на **9.39.4**, все действующие правила и исходную семантику fast-glob/micromatch. Локальный приватный fork braces **3.0.3-chronicle.1** добавляет только ограничение глубины. Полный и runtime audit на чистой установке — **0 vulnerabilities**, focused regressions — **40/40**, штатный последовательный `npm test` — **1181/1181**. Typecheck, lint и production build прошли.

## HIGH-1: переполнение стека в braces

- **Граница:** `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`.
- **Доказательство:** `focused-red.log` воспроизводит `RangeError: Maximum call stack size exceeded` в `braces/lib/expand.js` на 4500 вложенных скобках, при длине ниже прежнего лимита входа.
- **Воздействие:** чрезмерно вложенный glob из lint-конфигурации завершает процесс проверки. В текущей конфигурации без `settings.next.rootDir` этот glob-путь не вызывается; это не использовано как основание игнорировать advisory. Пользовательский текст кампаний в данную dev-зависимость не передаётся.
- **Исправление:** приватная копия оригинального MIT-пакета в `tooling/braces`, с сохранённой лицензией. `lib/depth.js:5` задаёт жёсткий предел 128. `lib/parse.js` проверяет глубину перед brace/paren blocks; compile/expand/stringify проверяют её при рекурсивном обходе, включая переданные готовые AST.
- **Поведение:** чрезмерная вложенность выдаёт явный `SyntaxError` с `code: ERR_BRACES_DEPTH`. Опции вызывающего кода не могут отключить этот предел. Результаты не обрезаются и корни приложений не пропускаются молча.

## Почему выбран локальный патч

Registry-проверки показали: latest braces остаётся 3.0.3; fast-glob 3.3.3 сохраняет micromatch/braces; latest Next plugin 16.4.2 по-прежнему использует fast-glob 3.3.1. Предложенный npm downgrade eslint-config-next до 14.2.35 не соответствует выбранному Next 16.

Проверялась замена fast-glob на tinyglobby, уже присутствующий транзитивно. Независимый review выявил реальные несовместимости: literal-directory expansion, Windows cross-drive absolute output, завершающие слеши, padded/stepped numeric braces, directory junctions и terminal globstar scope. Возможная замена только на brace-expansion меняет bracket/quote/malformed-pattern grammar и режим default compilation. Поэтому замены движка/грамматики отклонены.

Оставлен исходный стек библиотек с минимальной правкой источника ошибки. Исходные `index.js`, `lib/constants.js`, `lib/utils.js` и `LICENSE` сохранены побайтно. Четыре модуля получили depth checks; добавлен один маленький helper. Это **локальная поддерживаемая правка**, а не выпущенное upstream исправление.

Upstream артефакт: `https://registry.npmjs.org/braces/-/braces-3.0.3.tgz`, integrity `sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`. Файлы взяты из ранее выполненного чистого npm ci с проверенным lockfile; provenance/diff сохранены в output.

## Подключение и сохранённая совместимость

Root dev dependency `braces: file:./tooling/braces` используется через npm `$braces` reference в override, ограниченном цепочкой `@next/eslint-plugin-next@16.3.8 > fast-glob@3.3.1 > micromatch@4.0.8`. Это не глобальная подмена остальных потребителей. Прямой relative file spec внутри вложенного override оказался привязан к каталогу потребителя; root reference устраняет этот packaging дефект.

Docker dependencies stage копирует `tooling/braces` перед `npm ci`. `.dockerignore` не исключает каталог. Postinstall scripts и механизмы исправления node_modules на месте не добавлялись; `--ignore-scripts` сохраняется.

По сравнению с сохранённым началом этой задачи lockfile добавляет один локальный target, меняет root dev declaration и registry braces на local link. **Ни один оставшийся registry package, version, resolved, integrity или platform metadata не изменён; registry dependencies не добавлялись.** Оригинальные optional WASM и Linux libc entries сохранены вместо побочных изменений Windows npm.

`tests/eslint-next-glob.test.ts` вызывает установленный Next helper и реальный ESLint: literal/relative/absolute/Windows roots, arrays, files vs directories, hidden roots, glob/brace/extglob, padded/stepped ranges, links/junctions и target вне search base, globstar, безопасный отказ на прежнем crash input и нарушение no-html-link-for-pages. `tests/eslint-braces.test.ts` сохраняет grammar/default compile/nodupes/range rejection и проверяет все public depth entrypoints, границу 128/129 и literal quotes/brackets. В сумме добавлено **40 ordinary registrations** к прежним 1141.

## Итоговые проверки

Проверки используют физическую копию без `.env`, OS environment allowlist, фиктивный loopback DATABASE_URL и отключённые автоматические миграции. Реальные базы кампаний и платные провайдеры не вызываются. Full suite запускается штатным `npm test`, без изменения concurrency в package.json.

Скопированы и проверены SHA-256 для 613 repository files. Из них 521 файл вне README/docs остаётся побайтно одинаковым в рабочем каталоге и проверочной копии во время итоговых gates. Документация обновляется отдельно после получения результатов; прежние coverage percentages не переиздаются.

| Проверка | Результат |
| --- | --- |
| RED прежнего стека | Воспроизведён RangeError в expand |
| RED оригинальных public AST entrypoints | Зафиксирован до depth-патча |
| Focused regressions | 40/40, exit 0 |
| Полный npm audit с патчем | 0 vulnerabilities, exit 0 |
| Финальный чистый npm ci и npm ls | Exit 0 в проверочной копии и основном checkout; 385 установленных пакетов |
| Runtime npm audit | 0 vulnerabilities, exit 0 |
| npm test | 1181/1181, exit 0; fail/cancelled/skipped/todo 0; штатный последовательный скрипт, 13 минут 31 секунда |
| typecheck / lint / build | Все exit 0; штатный Next 16.3.8 Turbopack build |
| check:docs | 89 файлов / 362 локальные ссылки, exit 0; итог проверен после записи результатов |
| Независимый review окончательного патча | Без actionable findings; 40/40 focused и 9024 differential/boundary assertions |
| Минимальные Docker install inputs | npm ci и production prune exit 0; Next доступен, lint packages удалены, runtime audit 0 |

Raw evidence находится в `output/eslint-security-2026-10-18/`. Промежуточные результаты для отклонённых замен не считаются итоговой проверкой принятого решения.

Независимый review сравнил 3000 небольших шаблонов с оригинальным upstream в compile/expand/stringify и границы brace/paren/mixed nesting для всех четырёх API: 9024 assertions. Они не добавляются к ordinary test count. Проверка исходного fork diff и source provenance выполнена отдельно. Docker CLI в среде отсутствует: проверены точные dependency-stage inputs и prune, но сборка Linux container image не заявляется.

## Остаточные ограничения и удаление workaround

ESLint 9.39.4 продолжает выдавать upstream deprecated warning; переход на 10 не включён в security fix, потому что установленные React/JSX a11y plugins не допускают эту major-версию. Это предупреждение поддержки, не оставшаяся high-запись данного audit.

Продолжение от того же дня: этот исторический предел устранён [отдельным переходом на ESLint 10 и согласованный Next 16.4.2](eslint10-migration-2026-10-18.md). Сохранён тот же braces fork; override перенесён в root leaf из-за воспроизведённого конфликта наследования npm 11. Детали совместимости и актуальные проверки находятся в новом отчёте.

Depth-патч закрывает указанное переполнение стека; другие потенциальные способы расходования ресурсов при brace expansion этим этапом не объявляются переработанными. Сохранены действующие upstream range/expansion contracts. Нулевой npm audit сам по себе не оценивает приватный код: основание исправления — воспроизведение, guard diff, поведенческие регрессии и review.

При обновлении Next lint toolchain проверить upstream исправление/удаление цепочки. После успешного прохождения этих регрессий и полного audit удалить file dependency, nested override, `tooling/braces` и Docker COPY вместе. [Локальная инструкция](../tooling/braces/README.md), [план и запись решений](superpowers/plans/2026-10-18-eslint-chain-remediation.md).

При обслуживании зависимостей отдельно сверять новые advisory для upstream braces: приватное имя fork не связывает его автоматически с будущими registry advisories исходного пакета. Текущий патч и отчёт фиксируют проверку указанной уязвимости, а не бессрочную гарантию безопасности библиотеки.
