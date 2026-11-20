# Заглушки изображений для setup.json

Для нового `BlockListWidgetType` с `block_template_handle` заполни `setup.json` объектом `{"blocks": [...]}`. Если своих изображений ещё нет, в поле изображения стартового блока укажи числовой `fallback_id` из таблицы. Названия полей возьми из выбранного шаблона через `get_block_template`. MCP принимает содержимое setup.json строкой в `widget_type.setup` или файлом через `source_files.setup` при `create_widget_type`.

Это встроенная подборка реестра Liquidhub, проверенная 2026-09-28. Она доступна без магазина и сети. Полный [реестр](https://docs.liquidhub.ru/4%20поколение/Виджеты/fallback_registry/) и [JSON](https://docs.liquidhub.ru/data/fallback_registry.json) содержат другие варианты; формат описан в [документации setup.json](https://docs.liquidhub.ru/4%20поколение/Виджеты/setup/).

Выбирай сначала назначение, затем соотношение сторон. `aspect_ratio` = исходная ширина / исходная высота; размеры относятся к оригиналу. `landscape` — горизонтальное, `portrait` — вертикальное, `square` — квадратное. Для широкого слайда подойдёт 861 (≈3.35:1), квадратной карточки — 866 (1:1), вертикальной истории — 1753 (9:16). Разные поля desktop/mobile заполняй только если они есть в шаблоне.

Назначения (`category`):

- `banners` — баннеры и слайдеры;
- `stories` — истории и промо-подборки;
- `content` — фото и изображения контентных блоков;
- `backgrounds` — фоны и декоративные элементы;
- `benefits` — преимущества и инфографика;
- `brands` — логотипы, бренды и платёжные знаки;
- `social` — соцсети и мессенджеры;
- `icons` — интерфейсные иконки.

| fallback_id | category | Файл | orientation | Оригинал, px | aspect_ratio |
| --- | --- | --- | --- | --- | --- |
| 861 | banners | slider.jpg | landscape | 1408 × 420 | 3.352381 |
| 911 | banners | PS4_2.jpg | landscape | 1408 × 468 | 3.008547 |
| 934 | banners | banner-1.png | landscape | 555 × 370 | 1.500000 |
| 1114 | banners | PS8_4.jpg | square | 338 × 338 | 1.000000 |
| 859 | banners | banner_544x784.png | portrait | 544 × 784 | 0.693878 |
| 1072 | banners | 5.jpg | portrait | 328 × 492 | 0.666667 |
| 1013 | banners | hb_banner_moblite2.0.jpg | portrait | 375 × 723 | 0.518672 |
| 1753 | stories | widget_es3_story_1.jpg | portrait | 540 × 960 | 0.562500 |
| 1145 | stories | es1_5.jpg | portrait | 180 × 243 | 0.740741 |
| 1080 | stories | inst111.jpg | square | 256 × 256 | 1.000000 |
| 866 | content | widget_gi1_13.jpg | square | 696 × 696 | 1.000000 |
| 923 | content | pexels-photo-4559970.webp | landscape | 1920 × 1280 | 1.500000 |
| 975 | content | widget_mi1.jpg | landscape | 586 × 330 | 1.775758 |
| 880 | content | SP17.jpg | portrait | 544 × 784 | 0.693878 |
| 812 | backgrounds | widget_parallax.jpg | landscape | 1920 × 1500 | 1.280000 |
| 1594 | backgrounds | gray_block.png | landscape | 500 × 350 | 1.428571 |
| 1435 | benefits | benefit_1.png | square | 192 × 192 | 1.000000 |
| 1416 | benefits | benefit_3.png | square | 192 × 192 | 1.000000 |
| 1406 | benefits | benefit_4.png | square | 192 × 192 | 1.000000 |
| 1209 | brands | 600x600_logox3.png | square | 1801 × 1801 | 1.000000 |
| 1189 | brands | 928x600_logox3.png | landscape | 2785 × 1801 | 1.546363 |
| 1175 | brands | 600x928_logox3.png | portrait | 1801 × 2785 | 0.646679 |
| 1656 | brands | logo_default.svg | landscape | 404 × 297 | 1.360269 |
| 1695 | brands | Visa.svg | landscape | 56 × 18 | 3.111111 |
| 1687 | social | Telegram.svg | square | 24 × 24 | 1.000000 |
| 1701 | social | YouTube.svg | square | 24 × 24 | 1.000000 |
| 1697 | social | VK.svg | landscape | 25 × 24 | 1.041667 |
| 1242 | icons | play-button.png | square | 512 × 512 | 1.000000 |
| 1516 | icons | Medal.png | square | 32 × 32 | 1.000000 |
| 1523 | icons | MapPinLine.png | square | 32 × 32 | 1.000000 |
| 1562 | icons | PhoneCall.png | square | 32 × 32 | 1.000000 |

Пример для шаблона с полями `name` и `image` (имена замени на фактические поля выбранного шаблона):

```json
{
  "blocks": [
    { "name": "Первый слайд", "image": 861 },
    { "name": "Второй слайд", "image": 911 }
  ]
}
```

ID из реестра используй в setup нового типа. Это не ID AccountFile магазина для `replace_widget_blocks` и не URL изображения для Liquid. Свои изображения существующих блоков загружай через `create_store_file` и используй полученный ID. Не заменяй реальные изображения заглушками при правке существующего виджета. После создания проверь стартовые блоки и изображения в редакторе и на витрине.
