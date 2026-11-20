# InSales MCP

MCP-сервер для работы с товарами, каталогом, контентом и темами магазина InSales из чата.

## Установка через агента

Скопируйте этот промпт в Codex, Cursor или другой агент с доступом к терминалу и файлам.

```text
Установи InSales MCP командой npm install -g insales-mcp-server. Нужен Node.js 22.13 или новее.
Определи файл настроек MCP моего клиента и добавь в него сервер insales. Если файла ещё нет, создай его в стандартном месте для этого клиента.
Используй команду insales-mcp и транспорт stdio. Если клиент не видит команду в PATH, укажи абсолютный путь к ней.
Сохрани остальные настройки и уже введённые реквизиты. Для нового подключения используй следующие заполнители в окружении сервера.
INSALES_STORE_URL=https://shop.myinsales.ru
INSALES_API_KEY_ID=<api-key-id>
INSALES_API_KEY_PASSWORD=<api-key-password>
Пришли кликабельную ссылку на локальный файл, который ты изменил, и покажи, какие поля мне заполнить.
Я добавлю реквизиты в файл сам. Не проси присылать ключ в чат.
```

Подставьте HTTPS-адрес магазина, идентификатор и пароль API-ключа. Затем перезапустите клиент. [Как создать API-ключ в InSales](https://www.insales.ru/collection/doc-rabota-s-api-i-prilozheniya/product/kak-sdelat-zapros-k-api)

Проверьте подключение запросом «Покажи первые пять товаров из моего магазина InSales с ID и названиями».

## Ручная настройка

Сервер можно запускать через `npx -y insales-mcp-server@latest`. Используйте [пример JSON](mcp.example.json) или [конфигурацию Codex](docs/configuration.md#codex).

[Параметры доступа, режимы и диагностика](docs/configuration.md) · [Пакет npm](https://www.npmjs.com/package/insales-mcp-server) · [Лицензия MIT](LICENSE)
