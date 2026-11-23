# Темы: ресурсные инструменты MCP

Ресурсы редактора, включая общие блоки, панели и шаблоны блоков, находятся под
`/admin/theme_editor/v1/`. Файлы магазина используют `/admin/files`.
Читаются темы поколений 2, 3 и 4. Изменяются только темы поколения 4.
У темы и виджета поле writable равно true только для поколения 4. У типа виджета
writable учитывает поколение и принадлежность пользовательского типа теме. Права
ключа проверяются отдельно при записи. Для приложения с правами на отдельные методы
обновление типа и копирование темы требуют права изменения темы (`themes#update`).
Запись в тему поколения 2
или 3 возвращает 409 read_only_generation с generation, writable_generations [4]
и outcome not_applied и не меняет данные.

`list_system_widget_types` принимает parameters.generation со значением 3 или 4,
по умолчанию 4. Другое значение — 422 validation_failed, field generation.
`get_system_widget_type` без этого параметра находит опубликованный неархивный
системный тип поколения 3 или 4 и возвращает поле generation. У типа поколения 2
source содержит snippet_file и snippet_content сниппета темы.

## Работа со страницей

1. `list_themes`, затем `get_theme` дают тему и ссылку предварительного просмотра.
2. `get_page_structure` с parameters.path и parameters.include="widgets,blocks"
   возвращает действующий шаблон, состав страницы и общие области. Общий шаблон
   влияет на все использующие его страницы; шапка/футер — на тему.
3. Настройки экземпляра меняет `update_widget`, блоки — `update_widget_block` или
   `replace_widget_blocks`. Код принадлежит типу и меняется через `update_widget_type`.
4. Для независимого кода сначала `make_widget_custom`. Для отдельного дизайна страницы
   вызовите `create_unique_template` с типом и ID владельца. Передайте `assign: true`,
   чтобы сразу назначить шаблон. Для существующего шаблона используйте
   `assign_page_template`.

Тело и query передаются в parameters. ID из пути — отдельные аргументы tool.
Для редактирования передавайте прочитанный `updated_at` как `parameters.expected_updated_at`,
сохраняя исходную точность до микросекунд. Для состава блоков используйте
`block_list_updated_at`, для сортировки WidgetList — `widget_list_updated_at`.
При 409 прочитайте изменения; автоматически заменять timestamp нельзя.
Опубликованная тема меняется сразу по обычным правам.

Для установки своих шрифтов во всей теме используйте `system_v4_fonts` и настройки
`custom-font-family-asset` / `custom-font-family-heading-asset`. Полный сценарий:
`search_knowledge(query="system_v4_fonts")`.

## Форматы и очистка

WidgetType.name — объект переводов. Переданный name заменяет все локали целиком.
JSON-поля settings_form/settings_data/setup/messages/block_settings_presets — объекты;
Liquid/CSS/JS — строки. settings_form сохраняет content/design и группы с items.
`get_widget_standards` содержит правила и диагностику разработки.

PATCH меняет только переданные ключи settings/fields, значение ключа заменяется целиком.
clear_settings очищает значение, reset_settings восстанавливает default; пересечения — ошибка.
Полный состав блоков заменяет replace_widget_blocks: переданный ID сохраняется,
запись без ID создаётся, пропущенная удаляется. Порядок массива — порядок блоков.
При полной замене position в элементах не передаётся.

Файл темы создаётся через `create_theme_asset` с name, type и ровно одним из
content (текст) или attachment (Base64). Имя бинарного файла берётся из name;
filename и src этим API не поддерживаются.

## Повторы и фон

Записи принимают operation_id (UUID) для локального журнала. Сохраните его перед
вызовом. Повтор завершённой операции возвращает сохранённый результат.
Только `duplicate_theme` отправляет Idempotency-Key и допускает повтор HTTP после
потерянного ответа: используйте `retry_theme_operation` с прежним ID в пределах часа.
Остальные неизвестные записи, включая создание виджета, файла, шаблона и backup,
повторно не отправляются. Прочитайте состояние магазина перед новым действием.
Новый замысел — новый ID; подмена ID не восстанавливает потерянный результат.

Нет обязательных preparation, validation, commands, dry_run или тематических черновиков.
Несколько ресурсных вызовов не образуют одну транзакцию. При ошибке проверяйте результаты
уже выполненных действий. Копирование шаблона — целостная серверная операция.
Копирование темы и backup возвращают job_id/status_url. Для состояния используются
`get_theme_duplication_status` и `get_theme_backup_status` с отдельным аргументом
job_id (UUID), без theme_id и parameters.job_id.
Backup и список резервных копий доступны через основную тему.

## Панели и блоки

Внутренние блоки Widget доступны через widget/blocks. Самостоятельные панели —
`list_block_panels`, без legacy scope. Списки возвращают items и pagination;
параметры page/per_page поддерживаются также для блоков виджета.
Состав панели идентифицируется ID блоков. list_item_id — отдельное вхождение
Widget в WidgetList, другая сущность. Legacy-списки доступны только для чтения.
Для полного состава используйте все страницы до pagination.next_page=null.

`get_widget_type_usage` показывает сохранённые экземпляры типа в выбранной теме.
`list_theme_history` и `list_widget_type_history` читают историю; конкретный diff
доступен через `get_theme_history_patch` и `get_widget_type_history_patch`.
Для списка WidgetList можно передать include=widgets и widget_fields=metadata;
параметр view у WidgetList не поддерживается.

## Проверка результата

`get_page_widgets` и `render_widget` рендерят сохранённое состояние в контексте
parameters.path. Несохранённые данные и draft_session_id не поддерживаются.
Проверяйте дизайн также на витрине. Для измерения Liquid используйте
`profile_theme_page`, list_item_id выбирает вхождение.
Товары, меню и контент меняются прямыми прикладными операциями с проверкой ревизии.
