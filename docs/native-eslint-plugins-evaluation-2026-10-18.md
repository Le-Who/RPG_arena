# Нативные ESLint 10 плагины: проверка перехода — 18 октября 2026

> Исторический этап с требованием полной эквивалентности preset. После разрешённого пользователем аудита неиспользуемых правил принят [нативный конфиг с политикой функционального TSX](react-eslint-native-policy-2026-10-18.md). Результаты и решение этого исследования ниже относятся к прежнему условию.

## Решение

Полный переход без потери действующих правил сейчас не принят. JSX a11y и import имеют подходящие нативные замены, но проверенный React-кандидат не сохраняет все 17 активных React-правил. Оставлены ESLint 10.13.0, Next/config/plugin 16.4.2, официальный compat 2.1.1 и текущие overrides. Dependency manifest, lockfile и конфигурация линтера не менялись в рамках этого этапа.

Это решение следует условию «если это улучшает работу проекта»: удаление названий workaround не должно ослаблять проверки или перекладывать сопровождение отсутствующих правил в локальный fork. Частичная замена a11y/import не решает React-блокер, а с текущим eslint-config-next оставляет прежние пакеты в dependency graph. Полный отказ от него потребовал бы самостоятельно собирать конфигурацию и выбирать парсер, сохраняя React bridge и peer-исключение. Измеримого ускорения активного import-правила этим исследованием не установлено.

## Проверенные кандидаты

| Плагин | Версия | ESLint peer / Node | Результат для текущего контракта |
| --- | --- | --- | --- |
| eslint-plugin-react | 7.37.5 | Через ESLint 9.7; Node ≥4 | Официальный релиз ещё не объявляет нативный ESLint 10 |
| @eslint-react/eslint-plugin | 5.28.1 | ESLint `*`; Node ≥20.19 | Нативный современный набор, но иной lint-контракт |
| eslint-plugin-jsx-a11y-x | 0.2.0 | ESLint 9/10; Node ^20.9 или ≥21.1 | Шесть действующих accessibility правил сопоставимы |
| eslint-plugin-import-x | 4.17.1 | ESLint 8.57/9/10; Node ^18.18/^20.9/≥21.1 | Активный anonymous export rule и используемый fixer сопоставимы |
| @htmlacademy/eslint-plugin-jsx-a11y | 6.11.0 | ESLint до 10; Node ≥24 | Сужает поддерживаемый проектом диапазон Node 20/22/24 |

Нативные кандидаты установлены обычным npm в отдельный disposable проект без overrides, force, legacy-peer-deps и lifecycle scripts. Установка, npm ls --all и audit прошли; audit 0. Основной checkout не получил эти экспериментальные зависимости.

## Воспроизведённые различия React

На отдельной установленной копии ESLint 10.13.0 подключён нативный unified plugin с максимально близким сопоставлением доступных действующих правил. Готовые recommended/strict presets не использовались: они меняют политику. В 14 invalid fixtures (семь вариантов на JSX и TSX) действующий конфиг выдаёт ошибки, а нативное сопоставление — ни одного сообщения. Корректные парные варианты допускаются обоими конфигами; fatal parse errors отсутствуют. Положительный контроль подтверждает, что нативный rule действительно запущен: обычное присваивание this.state.count = 1 диагностируется в JSX и TSX, в отличие от операторов обновления.

| Действующая проверка | Что теряет кандидат |
| --- | --- |
| no-direct-mutation-state | Операторы `++` и `--`: нативный rule обрабатывает assignment, но не UpdateExpression |
| no-direct-mutation-state | Компонент `class Decorated extends Base`, распознанный через JSDoc `@extends React.Component` |
| require-render-return | Метод render без return: встроенного эквивалента нет |
| no-is-mounted | Вызов this.isMounted(): встроенного эквивалента нет |
| no-deprecated | this.transferPropsTo(): современный набор lifecycle/DOM правил не покрывает историческую таблицу API полностью |
| no-unescaped-entities | Неэкранированные кавычки в JSX: встроенного эквивалента нет |

Полная карта всех 17 действующих правил отдельно фиксирует и другие несовпадения: jsx-no-duplicate-props и no-string-refs требуют пользовательских правил, jsx-no-undef заменяется более широким core no-undef, а display-name/jsx-key имеют отличающиеся границы. Смена namespace или алиас npm-пакета этого не устраняет. Наличие одноимённого no-direct-mutation-state само по себе оказалось недостаточным доказательством совместимости.

В существующий tests/eslint-toolchain-compat.test.ts добавлено восемь постоянных registrations: require-render-return, no-is-mounted, no-deprecated и increment/decrement в JSX и TSX. Они проверяют настоящие сообщения, severity и исправленные варианты. JSDoc и unescaped-entities уже покрывались. Расширенный focused набор: 87/87 (47 lint/peer и 40 прежних security/glob).

## Что готово у a11y и import

Native jsx-a11y-x прошёл 24 текущих valid/invalid cases: шесть правил × JSX/TSX × invalid/valid, с совпадением ID, severity, текста и позиций. Опция Next Image сохранена: alt-text с elements:[img], img:[Image]. Глобальные настройки будущей конфигурации должны называться jsx-a11y-x, даже если plugin зарегистрирован под прежним namespace jsx-a11y.

Native import-x прошёл 22 anonymous export cases на JS/TS и точное автоисправление import/order с сохранением комментария. Независимый resolver probe подтвердил Node, next/image, TypeScript alias и ожидаемую ошибку отсутствующего alias. При миграции внутренние settings должны называться import-x/parsers и import-x/resolver. Неактивное здесь no-unused-modules в этом релизе становится no-op на ESLint 10: поддержка активного правила не означает эквивалентности всех возможных правил плагина.

Одной замены plugin objects поверх eslint-config-next недостаточно: пакет продолжит устанавливать legacy React/a11y/import peers. Удаление peer-overrides требует устранить все такие потребители, включая React. Braces override имеет отдельное назначение — прежний depth security patch в Next → fast-glob → micromatch; нативные React/a11y/import плагины не удаляют эту цепочку.

## Проверки и возврат к миграции

Проверки повторены на физической копии без приватных env-файлов и provider credentials, с фиктивным loopback DSN и выключенными auto migrations. Все 522 non-document inputs сохранили исходные SHA-256 и совпали с основным checkout. Отдельная побайтовая сверка подтверждает сохранение package.json, package-lock.json и eslint.config.mjs относительно начала этого этапа.

| Проверка | Результат |
| --- | --- |
| Полный штатный npm test | 1228/1228, exit 0; fail/cancelled/skipped/todo 0; последовательный прогон около 15 минут |
| Focused regressions | 87/87: 47 lint/peer и 40 security/glob, exit 0 |
| Чистый npm ci / npm ls --all | Exit 0 на окончательной копии, 383 установленных пакета, без peer warnings |
| Full / runtime npm audit | 0 / 0 vulnerabilities, exit 0; повторены после полного набора |
| Typecheck / lint / build | Все exit 0; стандартный Next 16.4.2 Turbopack build |
| Production HTTP smoke | Реальный next start: version endpoint, manifest и static icon → 200; no-store и отсутствие identity cookie сохранены |
| Независимый review | 47/47 повторены; native assignment/update positive controls подтверждены; ссылка на upstream tag исправлена; открытых findings нет |
| Documentation checker | 93 файла / 376 локальных ссылок, exit 0; npm commands и migration ledger проверены |

Первый cold-start HTTP probe завершился по собственному короткому таймауту: он выходил из цикла готовности после заголовков, до полного JSON body. Чтение тела перенесено внутрь retry; окончательный smoke прошёл. Эта правка относится только к проверочному скрипту в output, код приложения не менялся. Live provider quality, настоящий PostgreSQL deployment и Linux container build не заявляются.

Вернуться к полному переходу можно после опубликованного нативного React-релиза с сохранёнными диагностическими границами либо отдельного согласованного изменения lint-политики. Критерий — прохождение текущих регрессий и сопоставление всех активных правил, а не только успешный npm install. [Предыдущая миграция ESLint 10](eslint10-migration-2026-10-18.md), [план этого этапа](superpowers/plans/2026-10-18-native-eslint-plugins.md).

Raw evidence: output/native-eslint-plugins-2026-10-18/, включая candidate-parity.json, полную react-research/react-parity.json и независимые a11y/import probes. Пакетные tarball эксперименты не объявляются изменениями рабочего toolchain.

## Первичные источники

- [React plugin: работа над ESLint 10](https://github.com/jsx-eslint/eslint-plugin-react/pull/4022).
- [Карта миграции современного ESLint React](https://eslint-react.xyz/docs/migrating-from-eslint-plugin-react).
- [Опубликованный no-direct-mutation-state](https://github.com/Rel1cx/eslint-react/blob/v5.28.1/plugins/eslint-plugin-react-x/src/rules/no-direct-mutation-state/no-direct-mutation-state.ts).
- [JSX a11y-x: migration и settings](https://github.com/eslint-community/eslint-plugin-jsx-a11y-x).
- [import-x](https://github.com/un-ts/eslint-plugin-import-x) и [ограничения релиза 4.17.1](https://raw.githubusercontent.com/un-ts/eslint-plugin-import-x/v4.17.1/CHANGELOG.md).
- [Next: использование lint plugin напрямую](https://nextjs.org/docs/app/api-reference/config/eslint).
