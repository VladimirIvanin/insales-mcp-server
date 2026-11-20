import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revision } from '../src/shared/common.js';

test('revisions preserve key normalization, null, missing fields and array order', () => {
  const content = { id: 1, settings: { b: 2, a: null } };
  assert.equal(
    revision(content),
    '7736a02448da8c3a234fef4ef86479bff3eae1ce0c7bdff79d1e4e73b2e1a559',
  );
  assert.equal(revision(content), revision({ settings: { a: null, b: 2 }, id: 1 }));
  assert.equal(
    revision({ id: 1, settings: { b: 2 } }),
    'a6c601a03f03403e9897dce863d4970f20056ba9e719a05794cbb89b3be54d2a',
  );
  assert.equal(
    revision({ ...content, items: [2, 1] }),
    'e9f6c71c458ab7753b853218c7130d0d5442799a9cb8cfb51683f3ad55ec1a69',
  );
  assert.notEqual(revision({ ...content, items: [2, 1] }), revision({ ...content, items: [1, 2] }));
});
