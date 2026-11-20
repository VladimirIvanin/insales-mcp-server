import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectWidgetBlocks } from '../src/features/themes/widgets/block-verification.js';

test('block verification accepts Rails serialization of translated titles and reference IDs', () => {
  const actual = [
    { position: 1, title: { ru: 'Кошки' }, fields: { collection: { value: '101' } } },
    { position: 2, title: { ru: 'Собаки', en: null }, fields: { collection: { value: '102' } } },
  ];
  const expected = [
    { position: 1, title: 'Кошки', fields: { collection: 101 } },
    { position: 2, title: { ru: 'Собаки' }, fields: { collection: { value: '102' } } },
  ];
  assert.equal(inspectWidgetBlocks(actual, expected), null);
  actual[1]!.fields.collection.value = '999';
  assert.deepEqual(inspectWidgetBlocks(actual, expected), {
    path: 'blocks[1].fields.collection.value',
    expected: '102',
    actual: '999',
  });
});
