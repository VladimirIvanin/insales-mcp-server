
# Виджеты InSales 4-го поколения

При создании любого виджета прочитай [editable-theme.md](editable-theme.md): в нём правила редактируемости контента, выбора изображений и форматирования Liquid. Правила отдельных секций применяй, когда собираешь страницу.

## Структура виджета

Каждый виджет — папка с файлами:

| Файл | Назначение |
|---|---|
| `snippet.liquid` | HTML-разметка (Liquid). Доступны `widget_settings`, `data.blocks`, `widget_messages` |
| `snippet.scss` | SCSS-стили. `&` — ссылка на `.layout.widget-type_{handle}` |
| `snippet.js` | JS. Автооборачивается в `try/catch`. Доступны `widget` и `$widget` |
| `info.json` | Метаданные: generation, type, handle, sku, libraries... |
| `settings_form.json` | Форма настроек редактора |
| `settings_data.json` | Значения настроек по умолчанию |
| `messages.json` | Переводы: ru, ua, en, es |
| `setup.json` | Блоки по умолчанию (только для blockListWidgetType) |
| `block_settings_presets.json` | AI-подсказки для блоков + флаг fixed_blocks (опционально) |
| `preview.jpg` / `mobile_preview.jpg` | Превью в галерее виджетов |

---

## Системная обёртка

### snippet.liquid

Код автоматически оборачивается в:

```html
<div
  class="layout widget-type_{handle}"
  style="--setting-name:value; --another:value;"
  data-widget-drop-item-id="123456"
>
  <!-- твой snippet.liquid -->
</div>
```

Все настройки из `settings_form.json` становятся CSS-переменными в `style`.

Доступные переменные в Liquid:
- `widget_settings.setting_name` — значение настройки
- `data.blocks` — блоки виджета (только blockListWidgetType)
- `widget_messages.key` — переводы из messages.json
- Все глобальные Liquid-переменные InSales: `account`, `product`, `collection`, `cart`, `linklists`, `settings` и др.

### snippet.js

Код автоматически оборачивается в:

```js
try {
  let widget = '.widget-type_{handle}'
  let $widget = $('.widget-type_{handle}')
  // твой snippet.js
} catch(error) {
  console.error('Widget "widget-type_{handle}"', error)
}
```

Для интерактивного виджета используй `WidgetLifecycle.mount(widget, initialize)`, если этот API доступен в целевой сборке. Ищи элементы и храни состояние внутри корня, переданного в функцию инициализации. В старых сборках используй `$widget.each()` и очищай ресурсы каждого экземпляра вручную. [Жизненный цикл виджета](runtime.md)

### snippet.scss

`&` — ссылается на `.layout.widget-type_{handle}`. Не добавляй класс виджета вручную, не используй `:root`.

Стили для разных состояний настроек через `[style*="..."]`:

```scss
@include background-color(--bg); // первая строка в 99% виджетов

.my-element {
  font-size: var(--font-size, 16px);
}

&[style*="--hide-title:true;"] .my-element__title {
  display: none;
}
```

---

## info.json

**Системный виджет** (`handle` начинается с `system_`):

```json
{
  "generation": 4,
  "type": "SimpleWidgetType",
  "handle": "system_widget_banner_1",
  "sku": "BB1",
  "page_kinds": ["all"],
  "widget_list_kinds": ["before_content", "content", "after_content", "footer"],
  "widget_category_handle": "banner",
  "name": { "ru": "Баннер", "en": "Banner" },
  "description": { "ru": "Описание", "en": "Description" },
  "libraries": ["jquery", "my-layout", "vanilla-lazyload"]
}
```

**Кастомный виджет** (handle без `system_`) — **без `sku`**, sku генерирует бэкенд:

```json
{
  "generation": 4,
  "type": "block_list_widget_type",
  "handle": "my_widget_1",
  "page_kinds": ["all"],
  "widget_list_kinds": ["content"],
  "widget_category_handle": "banner",
  "block_template_handle": "system-image-and-content",
  "name": { "ru": "Мой виджет", "en": "My widget" }
}
```

После правки запускай валидатор → [info-json-validation.md](info-json-validation.md).

**Типы виджетов:**
- `"SimpleWidgetType"` — без блоков
- `"blockListWidgetType"` — с блоками (нужен `block_template_handle` + `setup.json`)

**`page_kinds`:** `all`, `index`, `collection`, `product`, `cart`, `page`, `search`, `blog`, `article`, `favorite`, `compare`

**`widget_list_kinds`:** `top_panel`, `header`, `before_content`, `content`, `after_content`, `sidebar`, `footer`, `bottom_panel`, `outside`

**`libraries`:** `commonjs_v2`, `jquery`, `my-layout`, `vanilla-lazyload`, `splide`, `splide3`, `fslightbox`, `micromodal`, `body-scroll-lock`, `js-cookie`, `cut-list`, `nouislider`, `microalert`

---

## settings_form.json

Структура для виджетов поколения 4 строгая: корневой объект содержит ровно две вкладки `content` и `design`, обе обязательны и являются массивами групп. Каждая группа — объект с массивом `items`; поля разрешены только внутри `items`. Пустые вкладки и группы допустимы, название группы необязательно. Пустая форма: `{"content":[],"design":[]}`. Плоский словарь полей и дополнительные корневые ключи недопустимы.

```json
{
  "content": [
    {
      "group_name": "{{ messages.picture }}",
      "items": [
        {
          "name": "banner-img",
          "label": "{{ messages.picture }}",
          "type": "file",
          "general": true,
          "general_position": 1
        },
        {
          "class": "range",
          "name": "font-size",
          "label": "{{ messages.font_size }}",
          "type": "number",
          "min": 14,
          "max": 32,
          "step": 2,
          "unit": "px",
          "with_btns": true
        }
      ]
    }
  ],
  "design": [
    {
      "items": [
        { "name": "bg", "type": "color", "clearable": true },
        { "name": "layout-wide-bg", "type": "checkbox" }
      ]
    }
  ]
}
```

**Флаги полей:**
- `"general": true` — поле в основных настройках редактора
- `"general_position": N` — порядок в основных настройках
- `"enable_server_reload": true` — изменение перезагружает шаблон
- `"hide_mobile": true` — скрыто в мобильном редакторе
- `"branding_field": "logo"` — связь с брендинговыми данными магазина

Подробнее по типам полей → [settings-reference.md](settings-reference.md)

---

## settings_data.json

```json
{
  "layout-wide-bg": true,
  "layout-pt": 2,
  "layout-pb": 2,
  "hide-mobile": false,
  "hide-desktop": false,
  "font-size": 20,
  "img-ratio": 1.5,
  "title": {
    "ru": "Заголовок",
    "ua": "Заголовок",
    "en": "Title",
    "es": "Título"
  }
}
```

Текстовые поля с переводами — объект с ключами `ru`, `ua`, `en`, `es`.

---

## messages.json

```json
{
  "ru": {
    "title": "Заголовок",
    "picture": "Изображение",
    "blocks": "Блоки",
    "block": "Блок",
    "block_list": "Список блоков"
  },
  "ua": { "title": "Заголовок", "picture": "Зображення" },
  "en": { "title": "Title", "picture": "Image" },
  "es": { "title": "Título", "picture": "Imagen" }
}
```

Зарезервированные ключи для блочных виджетов: `blocks`, `block`, `block_list`.

Доступ в Liquid: `{{ widget_messages.title }}`.
Доступ в settings_form.json: `{{ messages.title }}`.

---

## block_settings_presets.json

Опциональный файл только для `blockListWidgetType`.

```json
{
  "fixed_blocks": true,
  "default_preset": {
    "fields": {
      "name": { "ai_text_max_symbols": 35 },
      "description": { "ai_text_max_symbols": 150 },
      "image": { "ai_image_orientation": "landscape" },
      "ai_image_category": "human"
    }
  }
}
```

- `fixed_blocks: true` — блоки нельзя добавлять/удалять в редакторе
- `ai_text_max_symbols` — максимальная длина AI-генерируемого текста для поля
- `ai_image_orientation` — ориентация AI-изображения: `"landscape"` или `"portrait"`
- `ai_image_category` — категория AI-изображения (например `"human"`)

---

## EventBus — события редактора

Подписывайся внутри существующего initializer виджета. Для событий настройки и цвета фильтруй по `data.widget_item_id`. Сравнивай строковое значение с `lifecycle.widgetItemId`: модуль считывает `data-widget-drop-item-id` с корня или ближайшего предка при mount и возвращает `null`, если атрибута нет.

```js
WidgetLifecycle.mount(widget, (root, lifecycle) => {
  const placementId = lifecycle.widgetItemId
  if (placementId === null) return

  EventBus.listen([
    'widget:input-setting:insales:system:editor',
    'widget:change-setting:insales:system:editor',
    'widget:input-color:insales:system:editor',
    'widget:change-color:insales:system:editor'
  ], data => {
    if (data?.widget_item_id == null || String(data.widget_item_id) !== placementId) return
    // Обнови компонент в root по data.setting_name, data.value, data.unit и data.type.
  }, { signal: lifecycle.signal })
})
```

`data.widget_id` соответствует ID виджета в редакторе и может быть общим для нескольких размещений. Если старый редактор передаёт только `widget_id`, сверяй payload с целевой сборкой и учитывай, что этого поля может не хватить для изоляции копий.

Если JS зависит от уже применённого значения CSS-переменной, зарегистрируй `lifecycle.onCssChange(fn)` внутри initializer. Функция получает `({ property }, root)` после применения основной переменной и связанных переменных цвета. Изменение настройки виджета уведомляет затронутое размещение. Изменение настройки темы уведомляет все активные экземпляры с таким обработчиком в редакторе. При уничтожении экземпляра модуль снимает обработчик. Для чисто визуального изменения достаточно CSS. [Быстрые CSS-настройки в LiquidHub](https://docs.liquidhub.ru/common.v2.js/widget-lifecycle/#css-settings)

---

## Дополнительные справочники (в этой же папке)

- [settings-reference.md](settings-reference.md) — все 15 типов настроек с параметрами и примерами
- [core-css-reference.md](core-css-reference.md) — классы и CSS-переменные библиотеки core.css / my-layout
- [icons-reference.md](icons-reference.md) — 82 иконки шрифта `insales-icons` на витрине
- [icons-editor-reference.md](icons-editor-reference.md) — 240 имён `mdi-*` для поля `icon` в `icon_group`
