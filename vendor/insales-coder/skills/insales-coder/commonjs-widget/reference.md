
# common.js — написание виджетов InSales 4-го поколения

## Подключение

В `info.json` виджета добавь `"commonjs_v2"` в массив `libraries`:

```json
{
  "generation": 4,
  "libraries": ["commonjs_v2", "jquery"]
}
```

Этого достаточно. Ничего в layout добавлять не нужно.

## Контекст виджета в snippet.js

В каждом `snippet.js` автоматически доступны:

- `widget` — CSS-селектор типа виджета (`.widget-type_{handle}`)
- `$widget` — jQuery-коллекция всех DOM-узлов этого виджета на странице

Для интерактивного виджета в поддерживаемой сборке передай `widget` в `WidgetLifecycle.mount` и работай с DOM внутри корня, полученного в initializer. Примеры на `$widget.each` используй с [ручной очисткой](../widget-architecture/runtime.md#ручная-очистка-в-старых-сборках), если целевая сборка не предоставляет lifecycle.

## Глобальные переменные common.js

| Переменная | Назначение |
|---|---|
| `Cart` | Корзина |
| `Products` | Работа с товарами |
| `FavoritesProducts` | Избранное |
| `Compare` | Сравнение |
| `AjaxSearch` | Живой поиск |
| `Shop` | Утилиты магазина (деньги, единицы) |
| `EventBus` | Шина событий |
| `WidgetLifecycle` | Инициализация и очистка экземпляров виджета в поддерживаемых сборках |
| `ajaxAPI` | Низкоуровневые AJAX-запросы |
| `Template` | Lodash-шаблонизатор |
| `InSalesUI` | UI-хелперы |
| `Tools` | Утилиты (url, translit) |

`$`/`jQuery` требует собственной зависимости `jquery`. Она не предоставляет `_`: если код использует глобальный Lodash, проверь его наличие и объявление отдельно; не полагайся на соседние секции.

## Важные ограничения

- Все async-методы (`Products.get`, `Products.getList` и т.д.) возвращают **jQuery Deferred** — используй `.done()` / `.fail()`, не `.then()`
- `mount` работает с корнями, уже доступными в DOM к моменту вызова. Для корней, вставленных позже, вызови `mount` после вставки.
- `EventBus.listen` и `EventBus.subscribe` могут сразу передать последние сохранённые данные. Подготовь состояние до подписки и проверяй источник. [Контракт EventBus](js-api.md#eventbus)

## Разделы документации

- [markup.md](markup.md) — data-атрибуты для `snippet.liquid`
- [js-api.md](js-api.md) — методы и события для `snippet.js`
- [ajax-components.md](ajax-components.md) — ui-ajax-products, ui-ajax-product, AJAX-фильтры
- [forms.md](forms.md) — формы обратной связи, отзывов, комментариев с капчей
- [patterns.md](patterns.md) — готовые паттерны из реальных виджетов

## Полезные ссылки

**Документация common.js:**
- [Старт / обзор](https://liquidhub.ru/collection/start)
- [Products](https://docs.liquidhub.ru/common.v2.js/2Products/)
- [Cart](https://docs.liquidhub.ru/common.v2.js/3Cart/)
- [AjaxSearch](https://docs.liquidhub.ru/common.v2.js/4AjaxSearch/)
- [Compare](https://docs.liquidhub.ru/common.v2.js/5Compare/)
- [FavoritesProducts](https://docs.liquidhub.ru/common.v2.js/6FavoritesProducts/)
- [EventBus](https://docs.liquidhub.ru/common.v2.js/7EventBus/)
- [WidgetLifecycle](https://docs.liquidhub.ru/common.v2.js/widget-lifecycle/)
- [ajaxAPI](https://docs.liquidhub.ru/common.v2.js/8ajaxAPI/)
- [ui-ajax-products](https://docs.liquidhub.ru/common.v2.js/ajax-products/ui-ajax-products/)
- [ui-ajax-product](https://docs.liquidhub.ru/common.v2.js/ajax-products/ui-ajax-product/)
- [ui-ajax-filters](https://docs.liquidhub.ru/common.v2.js/9ui-ajax-filters/)
- [ui-feedback](https://docs.liquidhub.ru/common.v2.js/10ui-feedback/)
- [ui-reviews](https://docs.liquidhub.ru/common.v2.js/ui-reviews/)
- [ui-comments](https://docs.liquidhub.ru/common.v2.js/ui-comments/)
- [ui-accessories (опции товара)](https://docs.liquidhub.ru/common.v2.js/ui-accessories/)
- [ui-quick-checkout](https://docs.liquidhub.ru/common.v2.js/ui-quick-checkout/)
- [Template](https://docs.liquidhub.ru/common.v2.js/12Template/)
- [InSalesUI](https://docs.liquidhub.ru/common.v2.js/13InSalesUI/)
- [Shop](https://docs.liquidhub.ru/common.v2.js/14Shop/)
