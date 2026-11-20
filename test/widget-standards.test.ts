import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { liquidSourceWarnings } from '../src/shared/liquid-diagnostics.js';
import { formatWidgetJsonFields, validateFields } from '../src/shared/validation.js';
import { ROOT } from '../src/shared/common.js';
import { widgetQualityWarnings } from '../src/shared/widget-diagnostics.js';
import { inspectRenderedHtml } from '../src/features/themes/widgets/rendered-html.js';

const duoRegression = JSON.parse(
  readFileSync(join(ROOT, 'test/fixtures/iphone-duo-regression.json'), 'utf8'),
) as {
  index_liquid: string;
  snippet_content: string;
  settings_form: string;
  settings_data: string;
};

test('unclosed angle brackets do not stall liquid diagnostics', () => {
  const started = performance.now();
  const warnings = liquidSourceWarnings('draft.liquid', '<'.repeat(200_000));
  assert.ok(performance.now() - started < 500, String(performance.now() - started));
  assert.deepEqual(warnings, []);
  const dense = '<div><span><b><i><em><a>' + 'x'.repeat(280);
  assert.ok(
    liquidSourceWarnings('dense.liquid', dense).some((warning) =>
      warning.includes('liquid_dense_source'),
    ),
  );
});

test('Cursor theme regression: hidden widget list and noneditable dense landing warn without blocking', async () => {
  const index = await validateFields(
    { kind: 'asset', theme_id: 10 },
    { inner_file_name: 'templates/index.liquid', content: duoRegression.index_liquid },
    { inner_file_name: 'templates/index.liquid' },
  );
  assert.deepEqual(index.errors, []);
  assert.ok(index.warnings.some((warning) => warning.includes('widget_list_truncated')));
  const namedLikeWidget = await validateFields(
    { kind: 'asset', theme_id: 10 },
    { inner_file_name: 'snippet.liquid', content: duoRegression.snippet_content },
    null,
  );
  assert.ok(namedLikeWidget.warnings.some((warning) => warning.includes('liquid_dense_source')));

  const landing = await validateFields(
    { kind: 'widget_type', theme_id: 10 },
    {
      type: 'SimpleWidgetType',
      snippet_content: duoRegression.snippet_content,
      settings_form: duoRegression.settings_form,
      settings_data: duoRegression.settings_data,
    },
    { type: 'SimpleWidgetType' },
  );
  assert.deepEqual(landing.errors, []);
  for (const code of [
    'liquid_dense_source',
    'widget_fixed_catalog_link',
    'widget_fixed_image',
    'widget_fixed_product_id',
    'widget_fixed_variant_id',
    'widget_content_static',
  ])
    assert.ok(
      landing.warnings.some((warning) => warning.includes(code)),
      code,
    );
  assert.equal(
    landing.warnings.some((warning) => warning.includes('widget_content_setting_unused')),
    false,
  );
});

test('Liquid diagnostics separate widget-list truncation from product limits and preserved text', async () => {
  const asset = { kind: 'asset' as const, theme_id: 10 };
  for (const content of [
    '{% for item in widget_lists.index-list.widgets %}{% widget item %}{% endfor %}',
    '{% for product in collection.products limit: 4 %}{{ product.title }}{% endfor %}',
    '<p>' + 'A long product description. '.repeat(25) + '</p>',
    '<img src="https://example.com/' + 'long-path/'.repeat(45) + 'image.jpg">',
    '<!-- <section><div><h1>Hidden</h1></div></section>'.repeat(8) + ' -->',
    '<pre>' + '<section><div><h1>Literal</h1></div></section>'.repeat(8) + '</pre>',
    '{% raw %}' + '<section><div><h1>Literal</h1></div></section>'.repeat(8) + '{% endraw %}',
    '{% assign markup = "' + '<section><div><h1>Literal</h1></div></section>'.repeat(8) + '" %}',
  ]) {
    const check = await validateFields(asset, { inner_file_name: 'index.liquid', content }, null);
    assert.deepEqual(check.errors, []);
    assert.equal(
      check.warnings.some((warning) => warning.includes('widget_list_truncated')),
      false,
      content,
    );
    assert.equal(
      check.warnings.some((warning) => warning.includes('liquid_dense_source')),
      false,
      content,
    );
  }
  for (const content of [
    '{% assign items = widget_lists.index-list.widgets | slice: 0, 1 %}',
    '{% for item in widget_lists.index-list.widgets offset: 1 %}{% widget item %}{% endfor %}',
    '{% assign item = widget_lists.index-list.widgets.first %}',
  ]) {
    const check = await validateFields(asset, { inner_file_name: 'index.liquid', content }, null);
    assert.ok(
      check.warnings.some((warning) => warning.includes('widget_list_truncated')),
      content,
    );
  }
});

test('formatted editable widget passes new source warnings after partial changes', async () => {
  const newSingleHeading = widgetQualityWarnings(
    { snippet_content: '<h1>Жёсткий заголовок</h1>' },
    null,
  );
  assert.ok(newSingleHeading.some((warning) => warning.includes('widget_content_static')));
  const form = JSON.stringify({
    content: [{ items: [{ name: 'hero_link', label: 'Ссылка', type: 'link' }] }],
    design: [{ items: [{ name: 'bg', label: 'Фон', type: 'color' }] }],
  });
  const snippet = [
    '<section class="hero">',
    '  <h1>{{ widget_settings.title }}</h1>',
    '  <p>{{ widget_settings.description }}</p>',
    '  <a href="{{ widget_settings.hero_link }}">{{ widget_settings.button_label }}</a>',
    '  {% for product in collection.products limit: 4 %}',
    '    <a href="{{ product.url }}">{{ product.title }}</a>',
    '  {% endfor %}',
    '</section>',
  ].join('\n');
  const before = {
    type: 'SimpleWidgetType',
    snippet_content: snippet,
    settings_form: form,
    snippet_js: '',
    snippet_scss: '',
  };
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const changedForm = await validateFields(target, { settings_form: form }, before);
  const changedSnippet = await validateFields(target, { snippet_content: snippet }, before);
  for (const result of [changedForm, changedSnippet]) {
    assert.deepEqual(result.errors, []);
    assert.equal(
      result.warnings.some((warning) =>
        /widget_fixed_|widget_content_static|liquid_dense_source/.test(warning),
      ),
      false,
    );
  }
  const platformSetting = await validateFields(
    target,
    { settings_form: form },
    { ...before, snippet_content: '<h1>{{ widget_settings.title }}</h1>' },
  );
  assert.deepEqual(platformSetting.errors, []);
  assert.equal(
    platformSetting.warnings.some((warning) => warning.includes('widget_content_setting_unused')),
    false,
  );
  const mixed = await validateFields(
    target,
    {
      snippet_content:
        '<h1>{{ widget_settings.title }}</h1><p>Статичный текст 1</p><p>Статичный текст 2</p><p>Статичный текст 3</p>',
    },
    before,
  );
  assert.ok(mixed.warnings.some((warning) => warning.includes('widget_content_static')));
});

test('widget diagnostics warn about platform wrapper and hidden empty widgets', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const wrapped = await validateFields(
    target,
    { snippet_content: '<section><div class="layout__content">x</div></section>' },
    {},
  );
  assert.deepEqual(wrapped.errors, []);
  assert.ok(wrapped.warnings.some((warning) => warning.includes('layout__content')));
  const hidden = await validateFields(
    target,
    { snippet_content: ' ', snippet_scss: '&{display:none!important}' },
    {},
  );
  assert.deepEqual(hidden.errors, []);
  assert.ok(hidden.warnings.some((warning) => warning.includes('display:none')));
  const regular = await validateFields(
    target,
    {
      snippet_content: '<a href="/collection/cats" style="padding:22px">Cats</a>',
      snippet_scss: '& { .card { color: var(--color-text); } }',
    },
    {},
  );
  assert.deepEqual(regular.errors, []);
  assert.ok(regular.warnings.some((warning) => warning.includes('категорию')));
  assert.ok(regular.warnings.some((warning) => warning.includes('отступы')));
});

test('global my-layout geometry warns while widget-local SCSS remains valid', async () => {
  const asset = { kind: 'asset' as const, theme_id: 10 };
  const invalid = await validateFields(
    asset,
    {
      inner_file_name: 'lapno.css',
      content: 'header .layout__content { width: 100% !important; padding: 0 !important; }',
    },
    null,
  );
  assert.deepEqual(invalid.errors, []);
  assert.ok(invalid.warnings.some((warning) => warning.includes('my-layout')));
  const local = await validateFields(
    { kind: 'widget_type', theme_id: 10 },
    {
      snippet_content: '<div class="card">Text</div>',
      snippet_scss: '& { .card { padding: 12px; } }',
    },
    {},
  );
  assert.deepEqual(local.errors, []);
});

test('absolute legacy layout indents require a safe widget root factor', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const before = { type: 'SimpleWidgetType', handle: 'custom_spacing' };
  const form = (unit: string) =>
    JSON.stringify({
      content: [],
      design: [{ items: [{ name: 'layout-pt', label: 'Верхний отступ', type: 'number', unit }] }],
    });
  const check = (fields: Record<string, unknown>, previous: Record<string, unknown> = before) =>
    validateFields(target, fields, previous);

  for (const unit of ['rem', 'px']) {
    const invalid = await check({ settings_form: form(unit), snippet_scss: '& { color: red; }' });
    assert.ok(invalid.errors.some((error) => error.includes('widget_layout_legacy_absolute')));
  }
  const newType = await validateFields(
    target,
    {
      handle: 'custom_spacing',
      generation: 4,
      settings_form: form('px'),
      snippet_scss: '& { color: red; }',
    },
    null,
  );
  assert.ok(newType.errors.some((error) => error.includes('widget_layout_legacy_absolute')));
  const scssOnly = await check({
    snippet_scss: '& { @media (max-width: 767px) { --layout-pb: 4rem; } }',
  });
  assert.ok(scssOnly.errors.some((error) => error.includes('layout-pb')));
  const dataOnly = await check({ settings_data: '{"layout-pt":"64px"}' });
  assert.ok(dataOnly.errors.some((error) => error.includes('layout-pt')));

  for (const factor of ['1', '.65']) {
    const valid = await check({
      settings_form: form('rem'),
      snippet_scss: `& { --layout-adaptive-vertical-indents-factor-decrease: ${factor}; }`,
    });
    assert.deepEqual(valid.errors, []);
  }
  const desktopOnly = await check({
    settings_form: form('rem'),
    snippet_scss:
      '@media (min-width: 768px) { & { --layout-adaptive-vertical-indents-factor-decrease: 1; } }',
  });
  assert.ok(desktopOnly.errors.some((error) => error.includes('widget_layout_legacy_absolute')));
  const oversized = await check({
    settings_form: form('rem'),
    snippet_scss: '& { --layout-adaptive-vertical-indents-factor-decrease: 2; }',
  });
  assert.ok(oversized.errors.some((error) => error.includes('widget_layout_legacy_absolute')));

  assert.deepEqual((await check({ settings_form: form('vw') })).errors, []);
  assert.deepEqual(
    (await check({ snippet_js: 'console.log("ok");' }, { ...before, settings_form: form('rem') }))
      .errors,
    [],
  );
  assert.deepEqual(
    (await check({ settings_form: form('rem') }, { ...before, system: true })).errors,
    [],
  );
});

test('pixel layout fields are accepted and satisfy the design setting check', async () => {
  const form = JSON.stringify({
    content: [],
    design: [
      {
        items: [
          { name: 'bg', label: 'Фон', type: 'color' },
          { name: 'layout-wide-bg', label: 'Широкий фон', type: 'checkbox' },
          { name: 'layout-wide-content', label: 'Широкий контент', type: 'checkbox' },
          { name: 'layout-edge', label: 'Без боковых отступов', type: 'checkbox' },
          { name: 'layout-pt-desktop-px', label: 'Сверху', type: 'number', unit: 'px' },
          { name: 'layout-pb-desktop-px', label: 'Снизу', type: 'number', unit: 'px' },
          { name: 'layout-pt-mobile-px', label: 'Сверху на телефоне', type: 'number', unit: 'px' },
          { name: 'layout-pb-mobile-px', label: 'Снизу на телефоне', type: 'number', unit: 'px' },
        ],
      },
    ],
  });
  const result = await validateFields(
    { kind: 'widget_type', theme_id: 10 },
    { settings_form: form, settings_data: '{"layout-pt-desktop-px":112,"layout-pt-mobile-px":64}' },
    { type: 'SimpleWidgetType', handle: 'custom_spacing' },
  );
  assert.deepEqual(result.errors, []);
  assert.equal(
    result.warnings.some((warning) => warning.includes('widget_design_settings')),
    false,
  );
});

test('JS is checked in its storefront wrapper and syntax findings stay nonblocking', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const valid = await validateFields(
    target,
    { snippet_js: '$widget.each(function () { console.log(widget); });' },
    {},
  );
  assert.deepEqual(valid.errors, []);
  assert.equal(
    valid.warnings.some((warning) => warning.includes('синтаксическая ошибка JS')),
    false,
  );
  const duplicateBinding = await validateFields(target, { snippet_js: 'let widget = 1;' }, {});
  assert.deepEqual(duplicateBinding.errors, []);
  assert.ok(
    duplicateBinding.warnings.some(
      (warning) => warning.includes('snippet.js') && warning.includes('синтаксическая ошибка JS'),
    ),
  );
  const liquid = await validateFields(
    target,
    { snippet_js: 'const color = "{{ widget_settings.bg }}";' },
    {},
  );
  assert.ok(liquid.warnings.some((warning) => warning.includes('JS с Liquid не проверен')));
  const asset = await validateFields(
    { kind: 'asset' as const, theme_id: 10 },
    { inner_file_name: 'theme.js', content: 'function (' },
    null,
  );
  assert.deepEqual(asset.errors, []);
  assert.ok(asset.warnings.some((warning) => warning.includes('theme.js')));
});

test('widget source diagnostics cover editable settings, known CSS variable and bracket collection links', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const fields = {
    settings_form: '{"content":[],"design":[{"items":[{"name":"bg","type":"color"}]}]}',
    snippet_scss: '.button { color: var(--color-btn-text); }',
    snippet_content: '<a href="{{ collections[\'dogs\'].url }}">Dogs</a>',
  };
  const validation = await validateFields(target, fields, {});
  assert.deepEqual(validation.errors, []);
  assert.ok(
    validation.warnings.some((warning) => warning.includes('bg') && warning.includes('label')),
  );
  assert.ok(validation.warnings.some((warning) => warning.includes('--color-btn-color')));
  assert.ok(validation.warnings.some((warning) => warning.includes('категорию')));
  const dotted = await validateFields(
    target,
    { snippet_content: '{{ collections.dogs.url }}' },
    {},
  );
  assert.ok(dotted.warnings.some((warning) => warning.includes('категорию')));
  const formatted = formatWidgetJsonFields({
    settings_form: fields.settings_form,
    snippet_js: 'const x = 1;',
  });
  assert.match(formatted.settings_form, /\n {2}"design"/);
  assert.equal(formatted.snippet_js, 'const x = 1;');
});

test('generation 4 widget settings form requires tabs, groups and typed fields', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  for (const source of ['[]', 'null', '"text"', '42']) {
    const validation = await validateFields(target, { settings_form: source }, {});
    assert.ok(
      validation.errors.some((error) => error.includes('корень JSON должен быть объектом')),
    );
  }
  const malformed = await validateFields(target, { settings_form: '{bad' }, {});
  assert.ok(malformed.errors.some((error) => error.includes('синтаксическая ошибка')));
  const blank = await validateFields(target, { settings_form: ' ' }, {});
  assert.ok(blank.errors.some((error) => error.startsWith('settings_form:')));
  for (const [source, path] of [
    ['{}', 'settings_form.content'],
    ['{"settings":[]}', 'settings_form.settings'],
    ['{"content":{}}', 'settings_form.content'],
    ['{"content":[{"name":"title","type":"text"}],"design":[]}', 'settings_form.content[0].items'],
    ['{"content":[{"items":[{}]}],"design":[]}', 'settings_form.content[0].items[0].type'],
    ['{"content":[{"items":[null]}],"design":[]}', 'settings_form.content[0].items[0]'],
    ['{"content":[],"design":[],"extra":[]}', 'settings_form.extra'],
    ['{"eyebrow":{"type":"text"},"title":{"type":"text"}}', 'settings_form.eyebrow'],
  ] as Array<[string, string]>) {
    const validation = await validateFields(target, { settings_form: source }, {});
    assert.ok(
      validation.errors.some((error) => error.includes(path)),
      source,
    );
  }
  for (const source of [
    '{"content":[],"design":[]}',
    '{"content":[{"items":[]}],"design":[]}',
    '{"content":[{"group_name":"Hero","items":[{"name":"title","type":"text","label":"Заголовок","general":true}]}],"design":[]}',
  ]) {
    const validation = await validateFields(target, { settings_form: source }, {});
    assert.deepEqual(validation.errors, []);
  }
  const missing = await validateFields(target, { generation: '4' }, null);
  assert.ok(missing.errors.some((error) => error.startsWith('settings_form:')));
  const legacy = await validateFields(
    target,
    { generation: '3', settings_form: '{"old":[]}' },
    null,
  );
  assert.equal(
    legacy.errors.some((error) => error.startsWith('settings_form:')),
    false,
  );
  const numericGeneration = await validateFields(
    target,
    { settings_form: '{"title":{"type":"text"}}' },
    { generation: 4 },
  );
  assert.ok(numericGeneration.errors.some((error) => error.includes('settings_form.title')));
  const jsOnly = await validateFields(target, { snippet_js: 'const x = 1;' }, { generation: '4' });
  assert.deepEqual(jsOnly.errors, []);
});

test('rendered HTML check finds container errors after Liquid expansion', () => {
  assert.deepEqual(inspectRenderedHtml('<div data-text=">"><section>ok</section></div>'), []);
  assert.deepEqual(inspectRenderedHtml('<script>const sample = "<div>";</script><div></div>'), []);
  assert.ok(
    inspectRenderedHtml('<div><section>missing</div>').some(
      (warning) => warning.code === 'closing_order' && warning.line === 1,
    ),
  );
  assert.ok(inspectRenderedHtml('<div>missing').some((warning) => warning.code === 'unclosed_tag'));
  assert.ok(inspectRenderedHtml('<div/>').some((warning) => warning.code === 'unclosed_tag'));
  assert.ok(
    inspectRenderedHtml('</div>').some((warning) => warning.code === 'unexpected_closing_tag'),
  );
});

test('quality diagnostics identify shared widget state and stay nonblocking', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const broken = await validateFields(
    target,
    {
      type: 'SimpleWidgetType',
      snippet_js:
        "var $root = $widget.find('[data-hero]'); var index = 0; $root.find('[data-next]').on('click', function () { $root.find('.slide').eq(index); });",
      snippet_content:
        "{% for block in data.blocks %}{% assign label = block.title %}{% case label %}{% when 'Кошки' %}🐈{% endcase %}{% endfor %}",
      settings_form:
        '{"content":[],"design":[{"items":[{"name":"bg","label":"Фон","type":"color"}]}]}',
    },
    {},
  );
  assert.deepEqual(broken.errors, []);
  for (const code of [
    'widget_js_shared_state',
    'widget_content_title_key',
    'widget_blocks_wrong_type',
    'widget_design_settings',
  ])
    assert.ok(
      broken.warnings.some((warning) => warning.includes(code)),
      code,
    );
  const noForm = await validateFields(target, { snippet_content: '<div>Text</div>' }, null);
  assert.ok(noForm.warnings.some((warning) => warning.includes('widget_design_settings')));

  const scoped = await validateFields(
    target,
    {
      snippet_js:
        "$widget.each(function (_, element) { const $instance = $(element); let index = 0; $instance.find('[data-next]').on('click', function () { index += 1; }); });",
    },
    { snippet_js: '' },
  );
  assert.deepEqual(scoped.errors, []);
  assert.equal(
    scoped.warnings.some((warning) => warning.includes('widget_js_shared_state')),
    false,
  );

  const crossScoped = await validateFields(
    target,
    {
      snippet_js:
        "$widget.each(function (_, element) { const $instance = $(element); $widget.find('[data-next]').on('click', function () {}); });",
    },
    { snippet_js: '' },
  );
  assert.ok(crossScoped.warnings.some((warning) => warning.includes('widget_js_instance_scope')));

  const editedSimple = await validateFields(
    target,
    { snippet_content: '{% for block in data.blocks %}{{ block.title }}{% endfor %}' },
    { type: 'SimpleWidgetType' },
  );
  assert.ok(editedSimple.warnings.some((warning) => warning.includes('widget_blocks_wrong_type')));
  const staticCards = await validateFields(
    target,
    { snippet_content: '<article>Delivery</article><article>Pickup</article>' },
    { type: 'SimpleWidgetType' },
  );
  assert.ok(staticCards.warnings.some((warning) => warning.includes('widget_content_static_list')));
});

test('slider and library diagnostics distinguish stateful code from harmless shared selection', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const slider = await validateFields(
    target,
    {
      snippet_js:
        "$widget.each(function (_, element) { new TvistV1($(element).find('.slider')[0], {}); });",
      libraries: ['my-layout'],
    },
    { snippet_js: '', libraries: ['my-layout'] },
  );
  assert.ok(slider.warnings.some((warning) => warning.includes('widget_js_missing_library')));
  const lifecycleSlider = await validateFields(
    target,
    {
      snippet_js: `WidgetLifecycle.mount(widget, (root, lifecycle) => {
        const slider = new TvistV1(root.querySelector('.slider'), {});
        lifecycle.onCleanup(() => slider.destroy());
      });`,
      libraries: ['commonjs_v2', 'tvist-v1'],
    },
    { snippet_js: '', libraries: ['commonjs_v2', 'tvist-v1'] },
  );
  assert.deepEqual(lifecycleSlider.errors, []);
  assert.equal(
    lifecycleSlider.warnings.some((warning) => warning.includes('widget_js_single_slider')),
    false,
  );
  const harmless = await validateFields(
    target,
    {
      snippet_js: "$widget.find('[data-static]').addClass('ready');",
    },
    { snippet_js: '' },
  );
  assert.equal(
    harmless.warnings.some((warning) => warning.includes('widget_js_shared_state')),
    false,
  );
  const manual = await validateFields(
    target,
    {
      snippet_js:
        "$widget.each(function (_, element) { $(element).find('[data-hero-next]').on('click', function () { $(element).find('.slide').removeClass('is-active').eq(0).addClass('is-active'); }); });",
    },
    { snippet_js: '' },
  );
  assert.ok(manual.warnings.some((warning) => warning.includes('widget_js_manual_slider')));
  assert.ok(
    manual.warnings.some(
      (warning) =>
        warning.includes('widget_js_manual_slider') && warning.includes('без смены библиотеки'),
    ),
  );
  const migrating = await validateFields(
    target,
    {
      snippet_js:
        "$widget.each(function (_, element) { new TvistV1($(element).find('.slider')[0], {}); });",
      libraries: ['tvist-v1'],
    },
    {
      snippet_js:
        "$widget.each(function (_, element) { new Splide($(element).find('.slider')[0]).mount(); });",
      libraries: ['splide'],
    },
  );
  assert.deepEqual(migrating.errors, []);
  assert.ok(migrating.warnings.some((warning) => warning.includes('widget_js_library_migration')));
  const newSlider = await validateFields(
    target,
    {
      snippet_js:
        "$widget.each(function (_, element) { new TvistV1($(element).find('.slider')[0], {}); });",
      libraries: ['tvist-v1'],
    },
    null,
  );
  assert.equal(
    newSlider.warnings.some((warning) => warning.includes('widget_js_library_migration')),
    false,
  );
});

test('Common.js purchase forms report missing integration attributes without blocking the draft', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const broken = await validateFields(
    target,
    {
      snippet_content: `<article><form action="{{ cart_url }}" method="post" data-label="A > B">
      <input type="hidden" name="variant_id" value="{{ product.variants.first.id }}">
      <button type="submit" data-item-add>В корзину</button>
    </form></article>`,
    },
    {},
  );
  assert.deepEqual(broken.errors, []);
  assert.ok(broken.warnings.some((warning) => warning.includes('widget_product_form_id')));
  assert.ok(broken.warnings.some((warning) => warning.includes('widget_product_form_quantity')));
  assert.equal(
    broken.warnings.some((warning) => warning.includes('widget_product_form_variant')),
    false,
  );

  const valid = await validateFields(
    target,
    {
      snippet_content: `<form action="{{ cart_url }}" data-product-id="{{ product.id }}">
      <input name="variant_id" value="{{ product.variants.first.id }}">
      <input name="quantity" value="1"><button data-item-add>В корзину</button>
    </form><form action="/contact"><button>Отправить</button></form>`,
    },
    {},
  );
  assert.equal(
    valid.warnings.some((warning) => warning.includes('widget_product_form_')),
    false,
  );

  const dynamic = await validateFields(
    target,
    {
      snippet_content: `<form action="{{ cart_url }}"><input name="variant_id" data-quick-variant>
      <button data-item-add>В корзину</button></form>`,
    },
    {},
  );
  assert.ok(dynamic.warnings.some((warning) => warning.includes('widget_product_form_id')));
  assert.ok(dynamic.warnings.some((warning) => warning.includes('widget_product_form_quantity')));
  assert.equal(
    dynamic.warnings.some((warning) => warning.includes('widget_product_form_variant')),
    false,
  );
});

test('setting picker diagnostics distinguish menu, collection and ordinary links', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const content = `{% assign menu = linklists[widget_settings.menu] %}
    {% assign selected = collections[widget_settings.category] %}
    <a href="{{ widget_settings.catalog-link }}">Каталог</a>`;
  const form = (items: unknown[]) => JSON.stringify({ content: [{ items }], design: [] });
  const textFields = [
    { name: 'menu', label: 'Меню', type: 'text' },
    { name: 'category', label: 'Категория', type: 'text' },
    { name: 'catalog-link', label: 'Ссылка', type: 'text' },
  ];
  const broken = await validateFields(
    target,
    {
      snippet_content: content,
      settings_form: form(textFields),
      settings_data: JSON.stringify({ 'catalog-link': '/collection/svet-i-optika' }),
    },
    {},
  );
  assert.deepEqual(broken.errors, []);
  assert.ok(
    broken.warnings.some((warning) => warning.includes('menu') && warning.includes('navigation')),
  );
  assert.ok(
    broken.warnings.some(
      (warning) => warning.includes('category') && warning.includes('collection'),
    ),
  );
  assert.ok(broken.warnings.some((warning) => warning.includes('widget_setting_collection_link')));

  const chosen = await validateFields(
    target,
    {
      snippet_content: content,
      settings_form: form([
        { name: 'menu', label: 'Меню', type: 'navigation' },
        { name: 'category', label: 'Категория', type: 'collection' },
        { name: 'catalog-link', label: 'Ссылка', type: 'link' },
      ]),
      settings_data: JSON.stringify({ 'catalog-link': '/collection/svet-i-optika' }),
    },
    {},
  );
  assert.equal(
    chosen.warnings.some((warning) => warning.includes('widget_setting_picker')),
    false,
  );
  assert.equal(
    chosen.warnings.some((warning) => warning.includes('widget_setting_collection_link')),
    false,
  );
});

test('HTML in text setting defaults recommends rich-text without blocking', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const form = (type: string) =>
    JSON.stringify({
      content: [{ items: [{ name: 'title', label: 'Заголовок', type }] }],
      design: [],
    });
  for (const title of [
    'Хорошие вещи<br>любят <em>дорогу.</em>',
    { ru: 'Хорошие вещи<br>любят дорогу', en: 'Good things' },
  ]) {
    const check = await validateFields(
      target,
      { settings_form: form('text'), settings_data: JSON.stringify({ title }) },
      {},
    );
    assert.deepEqual(check.errors, []);
    assert.ok(check.warnings.some((warning) => warning.includes('widget_setting_rich_text')));
  }
  for (const [type, title] of [
    ['text', 'Хорошие вещи < 3'],
    ['rich-text', 'Хорошие вещи<br>любят дорогу'],
  ] as Array<[string, string]>) {
    const check = await validateFields(
      target,
      { settings_form: form(type), settings_data: JSON.stringify({ title }) },
      {},
    );
    assert.equal(
      check.warnings.some((warning) => warning.includes('widget_setting_rich_text')),
      false,
    );
  }
});

test('promo slider warns when only the first editable block is rendered', async () => {
  const target = { kind: 'widget_type' as const, theme_id: 10 };
  const broken = await validateFields(
    target,
    {
      type: 'BlockListWidgetType',
      block_template_handle: 'system-promo-slider-6',
      snippet_content:
        '{% assign main = data.blocks.first %}<div>{{ main.name }}</div><div>01 / 03</div>',
    },
    {},
  );
  assert.ok(broken.warnings.some((warning) => warning.includes('widget_slider_static_first')));
  const sidePromos = await validateFields(
    target,
    {
      type: 'BlockListWidgetType',
      block_template_handle: 'system-promo-slider-6',
      snippet_content:
        '{% assign main = data.blocks.first %}<div class="hero">{{ main.name }}</div>{% for block in data.blocks offset: 1 limit: 2 %}<aside>{{ block.name }}</aside>{% endfor %}',
    },
    {},
  );
  assert.ok(sidePromos.warnings.some((warning) => warning.includes('widget_slider_static_first')));
  const working = await validateFields(
    target,
    {
      type: 'BlockListWidgetType',
      block_template_handle: 'system-promo-slider-6',
      snippet_content:
        '{% for block in data.blocks %}<div data-slide>{{ block.name }}</div>{% endfor %}',
    },
    {},
  );
  assert.equal(
    working.warnings.some((warning) => warning.includes('widget_slider_static_first')),
    false,
  );
});
