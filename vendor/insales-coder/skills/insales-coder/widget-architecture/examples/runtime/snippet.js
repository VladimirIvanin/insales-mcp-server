WidgetLifecycle.mount(widget, (root, lifecycle) => {
  const form = root.querySelector('form[data-product-id]');
  const preview = form?.querySelector('[data-variant-preview]');
  if (!preview) return;

  EventBus.listen('update_variant:insales:product', data => {
    if (data?.action?.product?.[0] !== form) return;

    preview.textContent = data.title || '';
  }, { signal: lifecycle.signal });
});
