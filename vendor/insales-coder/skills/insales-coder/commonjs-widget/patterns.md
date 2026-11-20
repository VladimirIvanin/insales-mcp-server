# Паттерны из реальных виджетов

## Уведомления через microAlert

```js
// Успех
microAlert('✓ Товар добавлен в корзину', 3000, { modificator: 'success-notice' })

// Предупреждение
microAlert('⚠ Достигнут лимит', 5000, { modificator: 'warning-notice' })

// Ошибка
microAlert('Ошибка', 5000, { modificator: 'error-notice' })
```

Типичный виджет уведомлений подписывается на события EventBus и вызывает microAlert:

```js
EventBus.subscribe('add_items:insales:cart', function(data) {
  if (!data.action.button) { return }
  microAlert('Товар добавлен', 3000, { modificator: 'success-notice' })
})

EventBus.subscribe('overload:insales:compares', function() {
  microAlert('Нельзя добавить больше товаров', 5000, { modificator: 'warning-notice' })
})

EventBus.subscribe('add_item:insales:favorites_products', function() {
  microAlert('Добавлено в избранное', 5000, { modificator: 'success-notice' })
})

EventBus.subscribe('error-feedback:insales:ui_feedback', function(data) {
  $.each(data.errors, function(i, val) {
    const errorText = typeof val == 'string' ? val : val[0]
    microAlert(errorText, 5000, { modificator: 'warning-notice' })
  })
})
```

---

## Модальный превью товара

Паттерн из `system_widget_v4_special_products_11` — открытие карточки товара в модалке.

```js
function ModalProductPreview(widgetClass) {
  const dop_class = widgetClass.slice(1)

  this.rootNode = $('<div class="modal-product-preview ' + dop_class + '"></div>').appendTo('body')
  this.contentNode = $('<div class="modal-product-preview__content"></div>').appendTo(this.rootNode)
  this.overlayNode = $('<div class="modal-product-preview-overlay ' + dop_class + '"></div>').appendTo('body')

  this.overlayNode.on('click', () => { this.close() })

  this.open = function(content) {
    this.contentNode.html('').append(content)

    // ОБЯЗАТЕЛЬНО инициализировать логику вариантов после вставки DOM
    Products.initInstance(this.rootNode.find('[data-product-id]'))
      .done(() => {
        FavoritesProducts.update()
        Compare.update()
        this.overlayNode.addClass('is-open')
        this.rootNode.addClass('is-open')
      })
      .fail((err) => { console.log(err) })
  }

  this.close = function() {
    this.overlayNode.removeClass('is-open')
    this.rootNode.removeClass('is-open')
  }
}

// Использование
$(function() {
  const modal = new ModalProductPreview(widget)

  $widget.on('click', '[data-product-preview-btn]', function(e) {
    e.preventDefault()
    const $productForm = $(this).closest('[data-product-id]').clone()
    modal.open($productForm)
  })
})
```

---

## Недавно просмотренные товары

```js
$widget.each(function(index, el) {
  const $el = $(el)

  Products.getRecentlyViewed().done(function(productIds) {
    if (!productIds || productIds.length === 0) {
      $el.addClass('is-empty')
      return
    }

    // Исключить текущий товар на странице товара
    const curProductId = $el.find('[data-is-page-product]').data('isPageProduct')
    if (typeof curProductId !== 'undefined') {
      const idx = productIds.indexOf(curProductId)
      if (idx !== -1) { productIds.splice(idx, 1) }
    }

    if (productIds.length === 0) {
      $el.addClass('is-empty')
      return
    }

    Products.getList(productIds).done(function(data) {
      // Сортируем в том же порядке что и productIds
      const sorted = productIds.map(id => data[id]).filter(Boolean)

      sorted.forEach(product => {
        const html = `
          <a href="${product.url}">
            <img src="${product.first_image.medium_url}" alt="${product.title}">
            <div>${product.title}</div>
            <div>${Shop.money.format(product.price_min)}</div>
          </a>
        `
        $el.find('.js-products-list').append(html)
      })
    }).fail(err => console.log(err))
  })
})
```

---

## Несколько инстансов виджета на странице

В поддерживаемой сборке используй [`WidgetLifecycle.mount`](../widget-architecture/runtime.md#штатный-жизненный-цикл). В старых сборках ограничивай DOM текущим корнем в `$widget.each()` и [снимай обработчики при очистке](../widget-architecture/runtime.md#ручная-очистка-в-старых-сборках).

```js
$widget.each(function(index, el) {
  const $el = $(el)

  // Все селекторы — только внутри $el, не через $widget или $(widget)
  const $btn = $el.find('[data-my-btn]')
  const $counter = $el.find('[data-my-counter]')

  $btn.on('click', function() {
    $counter.text(parseInt($counter.text()) + 1)
  })
})
```

---

## Смена варианта товара: безопасное обновление картинки

Проблема: глобальная подписка на `change_variant:insales:product` без проверки инстанса виджета мутирует DOM во всех виджетах, где есть `.product-preview`.

Обязательные правила:

- Подписку делай внутри initializer и передавай `lifecycle.signal`
- Всегда проверяй, что форма товара из события принадлежит текущему инстансу:
  `$(productNode).parents('.layout:first').is($(el))`
- Перед `html(...)` сравни текущий `data-img-variant-id` с новым id и выходи, если id совпал
- Храни текущий id картинки в разметке (`data-img-variant-id`) и обновляй его после подмены
- Если подставляется одна картинка, не собирай массив `images`, а формируй один HTML-строковый шаблон
- Не ставь `type="image/webp"` для `large_url`, если URL не webp; `type` должен совпадать с реальным MIME
- `loading="lazy"` указывай на `<img>` (для `<source>` это нерабочий/игнорируемый атрибут)

```js
WidgetLifecycle.mount(widget, (el, lifecycle) => {
  EventBus.listen('change_variant:insales:product', function(data) {
    if (!data || !data.action || !data.action.product || !data.action.product[0]) return
    const productNode = $(data.action.product[0])
    const isCurrentWidgetInstance = productNode.parents('.layout:first').is($(el))
    if (!isCurrentWidgetInstance) { return }

    const $imageContainer = productNode.find('.product-preview__photo .product-preview__photo-variant')
    if ($imageContainer.length === 0) { return }

    let nextImage = null

    if (data.image_ids.length <= 1) {
      nextImage = data.images && data.images[0]
    } else {
      const variantImages = data.action.productJSON.images.filter(img => data.image_ids.includes(img.id))
      nextImage = variantImages[0] || data.action.productJSON.images[0]
    }

    if (!nextImage) { return }

    const currentImageId = Number($imageContainer.first().data('imgVariantId'))
    if (currentImageId === nextImage.id) { return }

    const nextImageHtml =
      '<picture>' +
        '<img src="' + nextImage.large_url + '" class="product-preview__img" loading="lazy">' +
      '</picture>'

    $imageContainer
      .attr('data-img-variant-id', nextImage.id)
      .data('imgVariantId', nextImage.id)
      .html(nextImageHtml)
  }, { signal: lifecycle.signal })
})
```

---

## Уведомление о добавлении в корзину (popup)

Паттерн из `system_widget_v4_notification_add_to_cart_1`:

```js
EventBus.subscribe('add_items:insales:cart', function(data) {
  if (!data.action.button) { return }

  // Не показывать если нажали кнопку счётчика
  const isCounterBtn = $(data.action.button[0]).attr('data-add-cart-counter') !== undefined
  if (isCounterBtn) { return }

  if (!data.action.currentItems || !data.action.currentItems.length) { return }

  const variantId = data.action.currentItems[0].variant_id
  let currentProduct = null

  Cart.order.order_lines.forEach(cartItem => {
    if (cartItem.variant_id === variantId) {
      currentProduct = cartItem
    }
  })

  if (!currentProduct) { return }

  $(widget).find('.notification__photo img').attr('src', currentProduct.first_image.medium_url)
  $(widget).find('.notification__title').html(currentProduct.title)
  $(widget).find('.notification__price').html(Shop.money.format(currentProduct.sale_price))

  $(widget).addClass('is-show')
})

$(document).ready(function() {
  $(widget).find('.js-close').on('click', function() {
    $(widget).removeClass('is-show')
  })

  // Закрытие по клику вне попапа
  $(widget).on('click', function(event) {
    if ($(event.target).closest(widget + ' .notification__content').length) { return }
    $(widget).removeClass('is-show')
  })
})
```

---

## Реакция на изменение настроек в редакторе

Фильтруй изменения настроек по ID размещения. Если JS читает применённую CSS-переменную, используй `lifecycle.onCssChange`. [Подписка на события редактора](../widget-architecture/reference.md#eventbus--события-редактора)

---

## Динамическое обновление корзины

Паттерн для страницы корзины — скрывать форму когда корзина пуста:

```js
EventBus.subscribe('delete_items:insales:cart', function(data) {
  if (data.order_lines.length === 0) {
    $widget.find('[data-cart-form]').addClass('hidden')
    $widget.find('.js-cart-empty').removeClass('hidden')
  }
})

// Перезагрузить страницу при добавлении товара из другого виджета
EventBus.subscribe('add_items:insales:cart', function() {
  window.location.reload()
})
```

---

## Загрузка ajax-товаров по вкладкам

Паттерн из `system_widget_v4_special_products_tabs_4_2`:

```js
$(function() {
  $widget.each(function(widgetIndex, thisWidget) {
    // Атрибут для идентификации инстанса при подписке на события
    $(thisWidget).attr('data-widget-version', widgetIndex)

    // Загрузить активную вкладку при инициализации
    const activeListNode = thisWidget.querySelector('[data-ajax-products-list]')
    if (activeListNode) {
      EventBus.publish('ui-ajax-products:load-products-list', activeListNode)
    }

    // Переключение вкладок
    $(thisWidget).on('click', '[data-tabs-item]', function() {
      const tabId = $(this).data('tabsItem')
      const $tab = $(thisWidget).find('#' + tabId)

      $(thisWidget).find('.is-active').removeClass('is-active')
      $tab.addClass('is-active')
      $(this).addClass('is-active')

      // Загрузить товары вкладки
      const listNode = $tab[0].querySelector('[data-ajax-products-list]')
      if (listNode) {
        EventBus.publish('ui-ajax-products:load-products-list', listNode)
      }
    })

    // Обработка после загрузки
    function onProductsInit(data) {
      const dataWidget = data.productsListNode.closest('[data-widget-version]')
      if (!dataWidget) { return }
      if (parseInt(dataWidget.dataset.widgetVersion) !== widgetIndex) { return }

      FavoritesProducts.update()
      Compare.update()
      new LazyLoad({ container: data.productsListNode, elements_selector: '.lazyload' })
    }

    EventBus.subscribe('init-products:ui-ajax-products', onProductsInit)
  })
})
```
