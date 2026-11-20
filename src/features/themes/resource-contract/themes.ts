export const themesAndSettings = [
  {
    id: 'target-themes-index',
    name: 'list_themes',
    method: 'GET',
    path: '/admin/theme_editor/v1/themes.json',
    title: 'Список тем',
    rules:
      'Полный список видимых тем, без скрытой обрезки. Поле description в целевой v1 не включаем. Поле writable равно true только у поколения 4.',
    idempotent: false,
    request_fields: [],
    read_only: true,
  },
  {
    id: 'target-themes-show',
    name: 'get_theme',
    method: 'GET',
    path: '/admin/theme_editor/v1/themes/:theme_id.json',
    title: 'Получить тему',
    rules:
      'Название и состояние темы, без description. Сохранение данных и готовность CSS/JS различаются. Поле writable равно true только для поколения 4. Запись в поколение 2 или 3 возвращает 409 read_only_generation с generation, writable_generations [4] и outcome not_applied, без изменения данных.',
    idempotent: false,
    request_fields: [
      {
        name: 'theme_id',
        location: 'path',
        type: 'integer',
        required: 'Да',
        description: 'ID темы.',
      },
    ],
    read_only: true,
  },
  {
    id: 'target-themes-update',
    name: 'update_theme',
    method: 'PATCH',
    path: '/admin/theme_editor/v1/themes/:theme_id.json',
    title: 'Изменить тему',
    rules:
      'Изменять только разрешённые переданные поля. Не менять generation, публикацию и состав этим методом.',
    idempotent: false,
    request_fields: [
      {
        name: 'theme_id',
        location: 'path',
        type: 'integer',
        required: 'Да',
        description: 'ID темы.',
      },
      {
        name: 'title',
        location: 'JSON',
        type: 'string',
        required: 'Да для этой правки',
        description: 'Название темы. Поле description исключено.',
      },
      {
        name: 'expected_updated_at',
        location: 'JSON',
        type: 'string (ISO 8601)',
        required: 'Нет',
        description:
          'updated_at прочитанного ресурса, с исходной точностью до 6 знаков. Устаревшее значение → 409 без записи.',
      },
    ],
    read_only: false,
  },
  {
    id: 'target-themes-publish',
    name: 'publish_theme',
    method: 'POST',
    path: '/admin/theme_editor/v1/themes/:theme_id/publish.json',
    title: 'Опубликовать тему',
    rules:
      'Публикует выбранную тему с проверкой прав и expected_updated_at. Мобильный режим определяется самой темой; параметр mobile не принимается.',
    idempotent: false,
    request_fields: [
      {
        name: 'theme_id',
        location: 'path',
        type: 'integer',
        required: 'Да',
        description: 'ID темы.',
      },
      {
        name: 'expected_updated_at',
        location: 'JSON',
        type: 'string (ISO 8601)',
        required: 'Нет',
        description:
          'updated_at прочитанного ресурса, с исходной точностью до 6 знаков. Устаревшее значение → 409 без записи.',
      },
    ],
    read_only: false,
  },
  {
    id: 'target-themes-delete',
    name: 'delete_theme',
    method: 'DELETE',
    path: '/admin/theme_editor/v1/themes/:theme_id.json',
    title: 'Удалить тему',
    rules:
      'Запреты удаления используемой/защищённой темы определяются платформой; при отказе — ошибка с причиной.',
    idempotent: false,
    request_fields: [
      {
        name: 'theme_id',
        location: 'path',
        type: 'integer',
        required: 'Да',
        description: 'ID темы.',
      },
      {
        name: 'expected_updated_at',
        location: 'JSON',
        type: 'string (ISO 8601)',
        required: 'Нет',
        description:
          'updated_at прочитанного ресурса, с исходной точностью до 6 знаков. Устаревшее значение → 409 без записи.',
      },
    ],
    read_only: false,
  },
  {
    id: 'target-themes-duplicate',
    name: 'duplicate_theme',
    method: 'POST',
    path: '/admin/theme_editor/v1/themes/:theme_id/duplicate.json',
    title: 'Создать копию темы',
    rules:
      'Асинхронная копия темы. Статус: GET /admin/theme_editor/v1/theme_duplications/:job_id.json. Idempotency-Key защищает повтор с теми же параметрами; другой запрос с тем же ключом отклоняется. После потерянного ответа повторяйте прежний operation_id в пределах часа.',
    idempotent: true,
    request_fields: [
      {
        name: 'theme_id',
        location: 'path',
        type: 'integer',
        required: 'Да',
        description: 'ID темы.',
      },
      {
        name: 'title',
        location: 'JSON',
        type: 'string',
        required: 'Нет',
        description: 'Название создаваемой копии.',
      },
      {
        name: 'language_id',
        location: 'JSON',
        type: 'integer',
        required: 'Нет',
        description: 'Язык копии.',
      },
      {
        name: 'Idempotency-Key',
        location: 'header',
        type: 'string',
        required: 'Нет',
        description:
          'Необязательный ключ повторного создания; хранение один час и пока задача активна. Те же параметры возвращают сохранённый результат; другие — 409.',
      },
    ],
    read_only: false,
  },
  {
    id: 'target-themes-duplicate-status',
    name: 'get_theme_duplication_status',
    method: 'GET',
    path: '/admin/theme_editor/v1/theme_duplications/:job_id.json',
    title: 'Получить результат копирования темы',
    rules:
      'Только результат конкретного копирования, доступный данному магазину и приложению. Не возвращать последнее произвольное задание.',
    idempotent: false,
    request_fields: [
      {
        name: 'job_id',
        location: 'path',
        type: 'string (UUID)',
        required: 'Да',
        description: 'job_id из ответа запуска операции.',
      },
    ],
    read_only: true,
  },
  {
    id: 'target-settings-show',
    name: 'get_theme_settings',
    method: 'GET',
    path: '/admin/theme_editor/v1/themes/:theme_id/theme_settings.json',
    title: 'Получить настройки темы',
    rules: 'Различать настройки темы и settings экземпляра Widget.',
    idempotent: false,
    request_fields: [
      {
        name: 'theme_id',
        location: 'path',
        type: 'integer',
        required: 'Да',
        description: 'ID темы.',
      },
      {
        name: 'locale',
        location: 'query',
        type: 'string',
        required: 'Нет',
        description: 'Локаль представления настроек.',
      },
    ],
    read_only: true,
  },
  {
    id: 'target-settings-update',
    name: 'update_theme_settings',
    method: 'PATCH',
    path: '/admin/theme_editor/v1/themes/:theme_id/theme_settings.json',
    title: 'Изменить настройки темы',
    rules:
      'Нормализация выполняется при записи. Подготовка не обязательна. Объявленные схемой ключи; не превращать этот метод в запись произвольных файлов.',
    idempotent: false,
    request_fields: [
      {
        name: 'theme_id',
        location: 'path',
        type: 'integer',
        required: 'Да',
        description: 'ID темы.',
      },
      {
        name: 'settings',
        location: 'JSON',
        type: 'object',
        required: 'Да',
        description: 'Непустой объект объявленных настроек темы.',
      },
      {
        name: 'locale',
        location: 'JSON',
        type: 'string',
        required: 'Нет',
        description: 'Локаль представления настроек.',
      },
      {
        name: 'expected_updated_at',
        location: 'JSON',
        type: 'string (ISO 8601)',
        required: 'Нет',
        description:
          'updated_at прочитанного ресурса, с исходной точностью до 6 знаков. Устаревшее значение → 409 без записи.',
      },
    ],
    read_only: false,
  },
] as const;

export const themeBackups = [
  {
    id: 'target-backups-index',
    name: 'list_theme_backups',
    method: 'GET',
    path: '/admin/theme_editor/v1/themes/:theme_id/backups.json',
    title: 'Список резервных копий',
    rules:
      'Резервные копии магазина через основную тему; для другой темы сервер возвращает primary_theme_required.',
    idempotent: false,
    request_fields: [
      {
        name: 'theme_id',
        location: 'path',
        type: 'integer',
        required: 'Да',
        description: 'ID темы.',
      },
      {
        name: 'page',
        location: 'query',
        type: 'integer',
        required: 'Нет',
        description: 'Номер страницы, начиная с 1.',
        default: 1,
      },
      {
        name: 'per_page',
        location: 'query',
        type: 'integer',
        required: 'Нет',
        description: 'По умолчанию 50, максимум 100.',
        default: 50,
      },
    ],
    read_only: true,
  },
  {
    id: 'target-backups-create',
    name: 'create_theme_backup',
    method: 'POST',
    path: '/admin/theme_editor/v1/themes/:theme_id/backups.json',
    title: 'Создать резервную копию',
    rules:
      'Асинхронная резервная копия основной темы. job_id и status_url возвращаются при запуске. Защиты Idempotency-Key нет; после потери ответа повтор запрещён.',
    idempotent: false,
    request_fields: [
      {
        name: 'theme_id',
        location: 'path',
        type: 'integer',
        required: 'Да',
        description: 'ID темы.',
      },
    ],
    read_only: false,
  },
  {
    id: 'target-backups-status',
    name: 'get_theme_backup_status',
    method: 'GET',
    path: '/admin/theme_editor/v1/backup_operations/:job_id.json',
    title: 'Получить результат резервного копирования',
    rules:
      'Резервные копии только основной темы поколения 4; список сохраняет существующую принадлежность магазину.',
    idempotent: false,
    request_fields: [
      {
        name: 'job_id',
        location: 'path',
        type: 'string (UUID)',
        required: 'Да',
        description: 'job_id из ответа запуска операции.',
      },
    ],
    read_only: true,
  },
] as const;
