# Категории товаров в каталоге

В бэкофисе и на витрине «категории товаров» — это API `collections` (`/collection/...`). Отдельный API `categories` представляет категории склада и в MCP не подключён. Источник: https://api.insales.ru/; в локальной платформе `BackOffice::Products::ApiCollectionsController` и `ApiCategoriesController` — разные контроллеры.

## Чтение и дерево

`read_content(kind=collection,mode=list,parent_id=...)` возвращает категории с `id`, `parent_id`, `title`, `position`, `is_hidden`, `is_smart`, `permalink`; `mode=get,id=...` возвращает поля и `revision`. Для прямых связей с товарами используй `read_content(kind=collect,mode=list,product_id=...)` либо `collection_id=...`. Смарт-категория может наполняться автоматически, поэтому `collects` не служит редактором её фильтров.

## Изменение

`change_collection(action=create)` требует `title` и `parent_id`. `action=update|delete` требует `id` и `base_revision` из чтения. Разрешены поля иерархии, видимости, сортировки, текста и SEO; `image_attributes.src` принимает публичный HTTPS URL, `field_values_attributes` — значения пользовательских полей. Создание/изменение автоматических смарт-фильтров не поддерживается: API чтения категории не возвращает их, и MCP не сможет проверить результат.

`change_collection_membership(action=add|remove,collection_id,product_id)` меняет только прямую связь с обычной категорией. Для удаления категории требуется отдельный явный запрос пользователя: корневую, непустую или имеющую дочерние категории удалить через MCP нельзя. MCP проверяет прямые связи и список товаров категории, включая смарт-категории, затем повторяет проверку перед DELETE; это не атомарная защита от параллельного изменения. Успешный DELETE возвращает `accepted_async`, поскольку физическая очистка в InSales идёт в фоне. При `execution_unknown` не создавай новый черновик для слепого повтора.
