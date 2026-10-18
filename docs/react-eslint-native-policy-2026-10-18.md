# Нативный ESLint 10 и правила, нужные приложению — 18 октября 2026

Последующий этап закрепил Node 22 LTS и отдельно проверил стабильность V8/PGlite. Результаты Node 24 ниже относятся к исходному этапу: [актуальная среда и проверки](v8-pglite-stability-2026-10-18.md).

## Решение и необходимость ESLint 10

Next 16 сам по себе не требует ESLint 10: его актуальное руководство допускает ESLint 9 и 10. Причина оставить уже установленный ESLint 10.13.0 — поддержка инструмента. ESLint 9 достиг EOL 6 августа 2026 года и больше не получает обновления команды ESLint. Переход не меняет поведение приложения и не ускоряет его сам по себе. [График ESLint](https://eslint.org/version-support/), [руководство Next](https://nextjs.org/docs/app/api-reference/config/eslint).

Предыдущая [проверка кандидатов](native-eslint-plugins-evaluation-2026-10-18.md) требовала точного сохранения всех правил исходного preset. Пользователь разрешил пересмотреть неиспользуемые правила после аудита реального React-кода. Этот этап меняет lint-политику осознанно; он не объявляет полную эквивалентность двух React-плагинов.

## Что действительно используется

`rg` и TypeScript AST проверили 455 файлов кода вне generated output, dependencies и revision snapshots. В `src/` — 215 файлов: 169 TS и 46 TSX. Из TSX десять относятся к app и 36 к components; 45 содержат JSX, всего 2513 element/self-closing/fragment nodes. `web-vitals.tsx` не содержит JSX. Весь JSX приложения находится в TSX и включён в текущий typecheck.

В app/components нет ни одного класса. В остальных исходниках есть девять подклассов Error и QueryVectorCache; все они находятся в TS и сохраняются. Не найдены импорты Component/PureComponent, классовые React-компоненты, createClass/create-react-class, string refs, this.state/refs/setState, isMounted, старые lifecycle-методы, transferPropsTo, React.PropTypes и исторические ReactDOM API. Единственный импорт react-dom в приложении — современный createPortal в dialog.tsx. Единственный memo — именованный FeedTurns в play-room.tsx. Классовые примеры старого lint-набора были строковыми fixtures, а не частью приложения.

## Принятая политика

| Прежние проверки | Решение |
| --- | --- |
| require-render-return, no-is-mounted, no-direct-mutation-state и классовая часть no-deprecated | Классового UI нет. В TSX core no-restricted-syntax запрещает ClassDeclaration и ClassExpression; служебные классы в TS разрешены |
| no-string-refs, старые React/ReactDOM API, no-find-dom-node, no-render-return-value | В приложении не используются. React 19 types и обязательный typecheck отвергают проверенные удалённые API и DOM string refs |
| jsx-no-undef и jsx-no-duplicate-props | Проверяет TypeScript: TS2304 и TS17001. JSX в JS/JSX/MJS/CJS отклоняется линтером, а постоянный тест проверяет включение всего JSX приложения в tsconfig |
| jsx-uses-react и jsx-uses-vars | Вспомогательные правила старого JSX scope больше не нужны; automatic JSX runtime и нативные parser/scope APIs используются напрямую |
| display-name, jsx-key, jsx-no-comment-textnodes | Нативные no-missing-component-display-name, no-missing-key, jsx-no-comment-textnodes остаются error |
| no-children-prop и no-danger-with-children | Сохранены через два jsx-no-children-prop правила и dom-no-dangerously-set-innerhtml-with-children, все error |
| no-unescaped-entities | Удалён как редакционное ограничение кавычек/апострофов в корректном JSX-тексте; неэкранированные `>` и `}` по-прежнему дают syntax errors |

Классовый guard намеренно использует core syntax, а не native no-class-component: последний пропускает переименованный импорт Component, присваивание superclass переменной и разрешает error boundaries. Если потребуется классовая error boundary, её ввод требует отдельного пересмотра этой TSX-политики. Guard не запрещает React-классы без JSX, написанные в TS.

В TSX default exports должны быть именованными: import-x/no-anonymous-default-export — error с allowCallExpression:false. В остальных файлах сохранён warn с прежними defaults. Для TS as/satisfies/non-null assertions сначала создаётся именованная переменная, затем экспортируется её имя; core restriction предотвращает обход через эти type wrappers. Это более строгая конвенция TSX exports, не требующая изменений существующего приложения.

Native display-name проверяет обычные memo/forwardRef bindings, но не является полным анализом aliases. Отдельное сравнение подтвердило: прежний React-плагин тоже пропускал переименованные memo/forwardRef и переменную-обёртку React.memo. Эти случаи не используются приложением. Прямые и as/satisfies/non-null-wrapped anonymous default calls получили отрицательные и положительные регрессии.

Native missing-key дополнительно проверяет mapped shorthand fragments. Все 22 Next Core Web Vitals правила, 16 React Hooks правил и 1174 globals совпали с предыдущей эффективной конфигурацией для TSX/TS/MJS. Шесть JSX a11y warnings и специальная alt-text опция Next Image сохранены. Рекомендованные React/a11y/import presets целиком не подключались: они добавили бы посторонние правила.

## Зависимости и совместимость

Прямой конфиг использует @eslint-react/eslint-plugin 5.28.1, eslint-plugin-jsx-a11y-x 0.2.0, eslint-plugin-import-x 4.17.1, eslint-plugin-react-hooks 7.1.1, @next/eslint-plugin-next 16.4.2 и @typescript-eslint/parser 8.71.2. Парсер согласован с зависимостью нативного React-плагина на utils ^8.71.2; дедупликация оставила один utils. Сохранены globals 16.4.0 и Node floor `^20.19.0 || ^22.13.0 || >=24`. Semver 7.8.5 объявлен напрямую для теста сырых peer-контрактов.

Удалены eslint-config-next, eslint-plugin-react, eslint-plugin-jsx-a11y, eslint-plugin-import и @eslint/compat вместе с root eslint override. Все опубликованные peer ranges в lockfile обязаны допускать установленный ESLint без исключений; установленный peer должен разрешаться в ту же версию. Next рекомендует прямой @next/eslint-plugin-next при раздельно настроенных React/a11y/import плагинах. Next и React runtime не изменены.

Независимый braces override/fork сохранён: Next plugin продолжает использовать fast-glob → micromatch. Его удаление определяется [security-регрессиями](eslint-dependency-remediation-2026-10-18.md), а не переходом на другие React-плагины. Output добавлен к ESLint ignores как каталог generated verification artifacts, уже исключённый из git.

Windows npm install оставил прежние физические optional зависимости, а lock-only dedupe удалил нужные WASM metadata. Восстановлены исходные записи core/runtime/wasi/sharp-wasm32 и libc сохранённых platform artifacts; чистый npm ci после восстановления прошёл без peer warnings. Первоначальные неуспешные/переходные команды не считаются итоговой проверкой.

Дедупликация также переразместила совместимые helper-зависимости. В пределах объявленных диапазонов обновлены dev PostCSS 8.5.28 → 8.5.30, разделяемый с Next PostCSS nanoid 3.3.19 → 3.3.20 и optional dev wasm-runtime 1.2.4 → 1.2.5; полный список изменений версий сохранён в final-lock-summary.json. Прямые runtime зависимости манифеста, версии Next, React, ReactDOM и TypeScript сохранены. Итоговый lock содержит 462 записи вместо 495; чистая установка добавляет 350 пакетов вместо 383.

Итоговый npm ls --all --json после полного прогона завершился с exit 0 в checkout и копии: invalid/missing 0, две optional/extraneous записи — @img/sharp-wasm32 и @emnapi/runtime. Промежуточный inventory при review показывал 104 записи, включая необязательный resolver peer import-x и его dependencies; эти промежуточные данные не подменяют окончательную сверку. Старые ESLint React/import/a11y плагины отсутствуют в lockfile. Кроссплатформенные Sharp/WASM записи сохраняются; полностью пустой optional inventory не заявляется.

## Проверки

Новая матрица заменяет тесты неиспользуемых legacy APIs самого линтера проверками принятой политики. Она исполняет настоящий ESLint config, проверяет severity и исправленные варианты, компилятор TypeScript, TSX coverage, class aliases/error boundaries, as/satisfies exports, комментарии и import-order autofix. Число регистрации тестов меняется осознанно: прежние 47 toolchain cases заменены 30 актуальными; 40 braces/Next filesystem cases сохраняются.

RED зафиксирован до конфигурации: 22/28 failures. Затем отдельно воспроизведены class-policy и wrapped-export gaps; окончательный focused набор прошёл 70/70.

Независимое ревью воспроизвело type-wrapper exports и неполное покрытие grouped compiler fixtures. Исправлены as/satisfies/non-null обходы и точные количества четырёх TS2305 и двух TS2339 diagnostics; все замечания этого scoped review закрыты. Нативный alias detection сопоставлен с прежним плагином, его ограничения не объявляются новой регрессией.

Первый полный запуск получил native V8 abort в checkpoint-boundaries после четырёх успешных cases: `jit_page_->allocations_.erase(addr) == 1`. Это не JavaScript assertion. Node 24.13.0 / V8 13.6.233.17-node.37 использует WebAssembly JIT; [открытая Node issue](https://github.com/nodejs/node/issues/66366) содержит ту же assertion и ссылается на [исправление lifetime race в V8](https://github.com/v8/v8/commit/9b8ca54d5a). Совпадение указывает на известную инфраструктурную проблему, но не доказывает точный механизм Windows/PGlite crash. PGlite 0.5.8 и pgvector 0.0.9 совпадают по version/resolved/integrity до изменения и в обеих копиях; checkpoint source/helper/service совпадают по SHA-256 с прежним успешно проверенным набором. Этот запуск не считается успешным; исходный лог сохранён для сопоставления с повтором.

Отдельный повтор неизменённого checkpoint-файла прошёл 44/44. Затем полный штатный npm test на том же Node 24.13.0 прошёл **1211/1211**, fail/cancelled/skipped/todo 0, около 10 минут. Приложение, тесты и V8/GC-флаги между первым и вторым полными запусками не менялись. Успешный повтор не объявляется исправлением upstream V8 race.

Сверка имён тестов и их кратности с предыдущим полным 1228-run подтвердила сохранение всех **1141 прикладных** и **40 security/glob** executions. Изменились только 47 прежних toolchain registrations → 30 актуальных. Missing application names: 0; test-inventory.json сохраняет результат.

| Проверка | Итог |
| --- | --- |
| Полный штатный npm test, повтор | 1211/1211, exit 0; fail/cancelled/skipped/todo 0 |
| Focused на окончательной физической копии | 70/70: 30 toolchain и 40 прежних security/glob |
| Checkpoint repeat после native abort | 44/44, без изменений тестов, Node или GC flags |
| Clean npm ci в checkout и копии | Exit 0 без peer warnings, 350 установленных пакетов |
| npm ls --all --json в checkout и копии | Exit 0; invalid/missing 0; две optional/extraneous Sharp/WASM записи |
| Full / runtime npm audit | 0 / 0 vulnerabilities после полного прогона |
| Typecheck / lint / production build | Все exit 0; Next 16.4.2 Turbopack |
| Production HTTP smoke | Реальный next start: version, manifest и icon → 200; no-store и отсутствие identity cookie сохранены |
| Независимое ревью | Замечания закрыты; toolchain 30/30 повторён независимо до последнего расширения non-null fixture, окончательные 70/70 проверены на копии |
| Сверка inputs | Все 522 non-document files совпадают с checkout и сохраняют SHA-256 перед общими проверками |
| Documentation checker | 94 файла / 383 локальные ссылки, exit 0 в checkout и копии; npm commands и migration ledger проверены |

Documentation checker повторён после окончательной записи результатов в этом отчёте и roadmap; внешние URL и anchors не входят в его проверку.

Полная проверка выполняется в физической копии repository inputs без приватных env и provider credentials, с фиктивным loopback DSN и выключенными auto migrations. Штатные тесты используют disposable fixtures/PGlite. Live provider quality, production PostgreSQL и hosted Linux/container execution этим изменением не проверяются.

Raw evidence: `output/react-policy-native-migration-2026-10-18/`. Исторические отчёты сохраняют результаты своих этапов: [ESLint 10 bridge](eslint10-migration-2026-10-18.md), [проверка полной эквивалентности](native-eslint-plugins-evaluation-2026-10-18.md).

## Первичные источники

- [ESLint version support](https://eslint.org/version-support/).
- [Next: direct plugin configuration](https://nextjs.org/docs/app/api-reference/config/eslint).
- [ESLint React migration mapping](https://eslint-react.xyz/docs/migrating-from-eslint-plugin-react).
- [Native display-name limits](https://eslint-react.xyz/docs/rules/no-missing-component-display-name).
- [Почему no-undef не включается поверх TypeScript](https://typescript-eslint.io/troubleshooting/faqs/eslint/).
- [JSX a11y-x](https://github.com/eslint-community/eslint-plugin-jsx-a11y-x) и [import-x](https://github.com/un-ts/eslint-plugin-import-x).
