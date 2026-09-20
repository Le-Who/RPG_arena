# Автозаполнение, игровая навигация и пилот Jev

Утверждено пользователем 20.09.2026. Реализовано с сохранением существующих кампаний. Протокол проверок и оставшиеся real-provider оценки: [эксплуатация](../../story-experience-operations.md).

## Task 1: Автозаполнение
Одна кнопка на любом из двух шагов свободной истории заполняет все пустые текстовые поля мира и героя. Непустые значения являются ограничениями, никогда не перезаписываются. Тон и роль изначально пусты; narrative остаётся выбранным профилем. Генерация не создаёт кампанию. POST /api/story-drafts/autofill принимает плоский draft всех полей формы, возвращает patch пустых полей и modelUsed. Валидировать поля, длины и списки на сервере. Только gemini-3.5-flash-lite, без Flash fallback, общий тайм-аут 30 секунд, максимум один repair невалидного JSON. Логирование taskType creation, sessionId null. Кнопка type=button, защита от double click и устаревшего ответа после редактирования/смены режима/закрытия. Переход между шагами: «Далее: герой и правила». Нет live: открыть настройки без потери формы. Проверки mock + 24 русскоязычных сценария для реальной оценки (не выдавать mock за eval).

## Task 2: Тип действия и навигация
Точное совпадение trim с текущим вариантом => custom false; любое иное изменение => true. Общий helper для кнопки/формы/Ctrl+Enter. Pending replay использует неизменённый тип. Видимый тип у поля. Скрытие только левого меню, desktop preference localStorage, mobile drawer. Sticky игровая панель ниже app header, чтение доступно всегда. Настройки поверх игры и формы, без unmount. Фокус, inert и hotkey блокировки; сохранить scroll/draft/reading/tab/older/pending. Не скроллить при commit под overlay. Возврат из настроек, защита несохранённых изменений Save/Discard/Continue. /settings остаётся страницей.

## Task 3: Jev shadow pilot
Отдельный второстепенный экран «Для разработки» из настроек. API /api/developer/typesafe: настройки, test, results. Key UI + TYPESAFE_API_KEY env priority, mask only, existing server-secret storage conventions. Disabled default. Fixed jev-1.13.0 official HTTP endpoint. После normalizeExtractedFacts до 6 Choice judgments одним запросом (supports/contradicts/unsupported), state narration/fact/evidence/action explicitly intent. 5 seconds total no retries. Ошибки/оценки не меняют сохранение фактов. Nullable JSON report memory_jobs + pilot config additive migration, report written under lease fence. Report model/prompt version/evaluations/confidence/usage/latency/status. 60 Russian labelled examples including negation/intention/hypothesis/ambiguity. Real eval separate from mocks. Existing lease/provenance/quote checks unchanged.

## Task 4: Проверка и документация
Unit/typecheck/lint/build; migration repeat + isolated database smoke/browser; desktop/mobile/200%; 24 story scenarios and 60 Jev examples; real provider only if credentials available. README, roadmap, worker docs report exact scope and checks. No deployment, no push or merge.
