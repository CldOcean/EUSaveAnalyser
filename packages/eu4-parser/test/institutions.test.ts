/**
 * Tests for the institution ("思潮") interpretation.
 *
 * The five worked examples in the "interpreting the array" test are the exact
 * cases the user spelled out, and they are the whole rule: a province has
 * embraced the Nth institution only when every slot up to it reached 100.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTITUTION_COUNT,
  INSTITUTIONS,
  embracingLabel,
  institutionLabel,
  readEmbracedCount,
  readInstitutionProgress,
} from '../src/institutions.ts';

test('the eight slots are the canonical order from the game files', () => {
  assert.equal(INSTITUTION_COUNT, 8);
  assert.deepEqual(
    INSTITUTIONS.map((i) => i.key),
    [
      'feudalism',
      'renaissance',
      'new_world_i',
      'printing_press',
      'global_trade',
      'manufactories',
      'enlightenment',
      'industrialization',
    ],
  );
  assert.equal(institutionLabel(0), '封建制度');
  assert.equal(institutionLabel(2), '殖民主义');
  assert.equal(institutionLabel(7), '工业化');
});

test('interpreting the embracement array', () => {
  // [0,100,100,...] has NOT embraced the first institution.
  assert.deepEqual(readInstitutionProgress([0, 100, 100, 0, 0, 0, 0, 0]), {
    embraced: 0,
    embracing: -1,
    embracingProgress: 0,
  });
  // [100,26,...] has embraced one and is working on the second.
  assert.deepEqual(readInstitutionProgress([100, 26, 100, 0, 0, 0, 0, 0]), {
    embraced: 1,
    embracing: 1,
    embracingProgress: 26,
  });
  // [100,100,100,100,10,...] has embraced four and is working on the fifth.
  assert.deepEqual(readInstitutionProgress([100, 100, 100, 100, 10, 0, 0, 0]), {
    embraced: 4,
    embracing: 4,
    embracingProgress: 10,
  });
  // A full leading run with nothing started afterwards.
  assert.deepEqual(readInstitutionProgress([100, 100, 100, 0, 0, 0, 0, 0]), {
    embraced: 3,
    embracing: -1,
    embracingProgress: 0,
  });
  // A gap *after* the run does not stop the run, it becomes the in-progress slot.
  assert.deepEqual(readInstitutionProgress([100, 100, 100, 89, 0, 0, 0, 0]), {
    embraced: 3,
    embracing: 3,
    embracingProgress: 89,
  });
  // Everything done.
  assert.equal(readInstitutionProgress([100, 100, 100, 100, 100, 100, 100, 100]).embraced, 8);
});

test('degenerate institution inputs are handled', () => {
  assert.deepEqual(readInstitutionProgress(undefined), {
    embraced: 0,
    embracing: -1,
    embracingProgress: 0,
  });
  assert.deepEqual(readInstitutionProgress([]), {
    embraced: 0,
    embracing: -1,
    embracingProgress: 0,
  });
  // A shorter array than the eight slots must not read past its end.
  assert.equal(readInstitutionProgress([100, 100]).embraced, 2);
  assert.equal(readInstitutionProgress([100, 50]).embracing, 1);
});

test('country embracement flags use the same leading-run rule', () => {
  assert.equal(readEmbracedCount([1, 1, 1, 0, 0, 0, 0, 0]), 3);
  assert.equal(readEmbracedCount([0, 1, 1, 0, 0, 0, 0, 0]), 0);
  assert.equal(readEmbracedCount([1, 1, 1, 1, 1, 1, 1, 1]), 8);
  assert.equal(readEmbracedCount(undefined), 0);
});

test('labels fall back gracefully', () => {
  assert.equal(institutionLabel(99), '无');
  assert.equal(institutionLabel(3, 'en'), 'Printing Press');
  assert.equal(embracingLabel(-1), '—');
  assert.equal(embracingLabel(4), '全球贸易');
});
