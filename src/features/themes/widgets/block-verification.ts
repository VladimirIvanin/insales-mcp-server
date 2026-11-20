import { canonical, isRecord, type Json } from '../../../shared/common.js';

export interface BlockMismatch {
  path: string;
  expected: unknown;
  actual: unknown;
}

function sameValue(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'boolean' && (actual === 't' || actual === 'f'))
    return expected === (actual === 't');
  if (Array.isArray(expected) && typeof actual === 'string') {
    try {
      const parsed: unknown = JSON.parse(actual);
      return (
        Array.isArray(parsed) &&
        expected.length === parsed.length &&
        expected.every((value: unknown, index: number) => sameValue(value, parsed[index]))
      );
    } catch {
      return false;
    }
  }
  return (
    canonical(expected) === canonical(actual) ||
    (expected !== null &&
      actual !== null &&
      (typeof expected === 'string' || typeof expected === 'number') &&
      (typeof actual === 'string' || typeof actual === 'number') &&
      String(expected) === String(actual))
  );
}

function sameTitle(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'string' && isRecord(actual))
    return Object.values(actual).some((value) => value === expected);
  if (isRecord(expected) && isRecord(actual))
    return Object.entries(expected).every(([locale, value]) => sameValue(value, actual[locale]));
  return sameValue(expected, actual);
}

export function inspectWidgetBlocks(
  actualBlocks: unknown,
  expectedBlocks: Json[],
): BlockMismatch | null {
  const actual = Array.isArray(actualBlocks) ? actualBlocks : [];
  const expected = [...expectedBlocks].sort((a, b) => Number(a.position) - Number(b.position));
  if (actual.length !== expected.length)
    return { path: 'blocks.length', expected: expected.length, actual: actual.length };

  for (const [index, block] of expected.entries()) {
    const saved: unknown = actual[index];
    const path = `blocks[${index}]`;
    if (!isRecord(saved)) return { path, expected: block, actual: saved };
    if (!sameValue(block.position, saved.position))
      return { path: `${path}.position`, expected: block.position, actual: saved.position };
    if (block.title !== undefined && !sameTitle(block.title, saved.title))
      return { path: `${path}.title`, expected: block.title, actual: saved.title };

    const fields = isRecord(block.fields) ? block.fields : {};
    const savedFields = isRecord(saved.fields) ? saved.fields : {};
    for (const [name, input] of Object.entries(fields)) {
      const wanted = isRecord(input) ? input : { value: input };
      const found = savedFields[name];
      const savedValue = isRecord(found) ? found.value : undefined;
      if (!sameValue(wanted.value, savedValue))
        return {
          path: `${path}.fields.${name}.value`,
          expected: wanted.value,
          actual: savedValue,
        };
      if (wanted.translations !== undefined) {
        const savedTranslations = isRecord(found) ? found.translations : undefined;
        if (!sameValue(wanted.translations, savedTranslations))
          return {
            path: `${path}.fields.${name}.translations`,
            expected: wanted.translations,
            actual: savedTranslations,
          };
      }
    }
  }
  return null;
}
