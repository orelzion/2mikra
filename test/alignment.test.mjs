// Regression tests for the פנינים alignment bugs: commentary landing on the
// wrong verse, and garbage verse refs ("Genesis 28:102").
//
// Offline on purpose — the fixtures reproduce the exact shapes Sefaria's v3
// text API returns (verified against live responses), so these run anywhere:
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  flattenVersesWithRefs,
  commentaryByVerse,
  nestingDepth,
  refToKvKey,
} from '../api/_sefaria.js';

// Sefaria returns section numbers as strings. That is the whole reason refs broke.
const GEN_28_10 = { indexTitle: 'Genesis', sections: ['28', '10'], toSections: ['28', '22'] };
const GEN_29_18 = { indexTitle: 'Genesis', sections: ['29', '18'], toSections: ['30', '13'] };

// ─── verse refs ───────────────────────────────────────────────────────────────

test('verse refs add to string sections instead of concatenating them', () => {
  const { verseRefs } = pairsOf(flattenVersesWithRefs(GEN_28_10, ['a', 'b', 'c']));
  // Concatenation gave ["Genesis 28:100", "Genesis 28:101", "Genesis 28:102"].
  assert.deepEqual(verseRefs, ['Genesis 28:10', 'Genesis 28:11', 'Genesis 28:12']);
});

test('multi-chapter refs roll over to verse 1 of the next chapter', () => {
  const { verseRefs } = pairsOf(flattenVersesWithRefs(GEN_29_18, [['a', 'b'], ['c', 'd']]));
  assert.deepEqual(verseRefs, ['Genesis 29:18', 'Genesis 29:19', 'Genesis 30:1', 'Genesis 30:2']);
});

test('a 13-verse single-chapter aliyah yields 13 consecutive refs ending at 28:22', () => {
  const text = Array.from({ length: 13 }, (_, i) => `v${i}`);
  const { verseRefs } = pairsOf(flattenVersesWithRefs(GEN_28_10, text));
  assert.equal(verseRefs.length, 13);
  assert.equal(verseRefs[0], 'Genesis 28:10');
  assert.equal(verseRefs.at(-1), 'Genesis 28:22');
});

test('no usable sections → null refs, not "NaN" refs', () => {
  const { verseRefs } = pairsOf(flattenVersesWithRefs({ indexTitle: 'Genesis' }, ['a']));
  assert.deepEqual(verseRefs, [null]);
});

test('client (app.js) derives exactly the same refs as the server', () => {
  // app.js is a plain browser script, so lift the function out of the source.
  // If the client and the generator ever disagree on a ref, a gem is stored
  // under a key the page never asks for — silently.
  const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const fn  = src.match(/function flattenVersesWithRefs\([\s\S]*?\n}\n/)?.[0];
  assert.ok(fn, 'flattenVersesWithRefs not found in app.js');
  const clientFn = vm.runInNewContext(`${fn}; flattenVersesWithRefs`);

  const cases = [
    [GEN_28_10, ['a', 'b', 'c', 'd']],
    [GEN_29_18, [['a', 'b'], ['c', 'd', 'e']]],
    [{ indexTitle: 'Genesis', sections: ['32', '1'] }, ['a']],
    [{ indexTitle: 'Genesis' }, ['a']],
  ];
  for (const [data, text] of cases) {
    const server = flattenVersesWithRefs(data, text).map(p => p.verseRef);
    // Array.from: arrays built inside vm carry another realm's prototype,
    // which strict deepEqual would reject even when the contents are identical.
    const client = Array.from(clientFn(data, text), p => p.verseRef);
    assert.deepEqual(client, server, JSON.stringify({ data, text }));
  }
});

// ─── commentary alignment ─────────────────────────────────────────────────────

test('nestingDepth counts levels down to the comment strings', () => {
  assert.equal(nestingDepth(['c1', 'c2']), 1);
  assert.equal(nestingDepth([['c1', 'c2'], ['c3']]), 2);
  assert.equal(nestingDepth([[['c1'], []], [['c2']]]), 3);
  assert.equal(nestingDepth([[], [], []]), 2);   // all-empty single-chapter slice
});

test('single-chapter range: every verse keeps only ITS comments', () => {
  // Shape of Rashi on Genesis 28:10-22: [verse][comment]. The old code treated
  // each inner array as a chapter and every comment as its own verse, so the
  // second comment on 28:10 ("r10b") landed on 28:11, and so on.
  const text = [['r10a', 'r10b', 'r10c'], ['r11a', 'r11b'], ['r12'], []];
  const by = commentaryByVerse('Genesis', GEN_28_10, text);

  assert.deepEqual(by.get('Genesis 28:10'), ['r10a', 'r10b', 'r10c']);
  assert.deepEqual(by.get('Genesis 28:11'), ['r11a', 'r11b']);
  assert.deepEqual(by.get('Genesis 28:12'), ['r12']);
  assert.equal(by.has('Genesis 28:13'), false);
  assert.equal(by.size, 3);
});

test('multi-chapter range: a trimmed chapter does not shift the next one', () => {
  // Ramban on Genesis 29:18-30:13 really comes back as 14 entries for the 18
  // verses of chapter 29. Positional flattening would slide chapter 30's
  // commentary onto chapter 29's verses 32-35.
  const text = [
    [['a29:18'], [], ['a29:20']],           // trailing empties trimmed
    [['b30:1'], ['b30:2'], [], ['b30:4']],
  ];
  const by = commentaryByVerse('Genesis', GEN_29_18, text);

  assert.deepEqual([...by.keys()], [
    'Genesis 29:18', 'Genesis 29:20', 'Genesis 30:1', 'Genesis 30:2', 'Genesis 30:4',
  ]);
  assert.deepEqual(by.get('Genesis 30:1'), ['b30:1']);
  assert.equal(by.has('Genesis 29:21'), false);
});

test('single verse: comments are one verse, not one verse each', () => {
  const by = commentaryByVerse('Genesis', GEN_28_10, ['c1', 'c2']);
  assert.deepEqual([...by.keys()], ['Genesis 28:10']);
  assert.deepEqual(by.get('Genesis 28:10'), ['c1', 'c2']);
});

test('empty, whitespace and missing data produce an empty map', () => {
  assert.equal(commentaryByVerse('Genesis', GEN_28_10, null).size, 0);
  assert.equal(commentaryByVerse('Genesis', GEN_28_10, undefined).size, 0);
  assert.equal(commentaryByVerse('Genesis', GEN_28_10, [[], [], []]).size, 0);
  assert.equal(commentaryByVerse('Genesis', GEN_28_10, [['  ', ''], []]).size, 0);
  assert.equal(commentaryByVerse('Genesis', null, [['x']]).size, 0);
  assert.equal(commentaryByVerse('', GEN_28_10, [['x']]).size, 0);
});

test('comments are trimmed and keyed under the mikra book, not "Rashi on Genesis"', () => {
  const data = { indexTitle: 'Rashi on Genesis', sections: ['28', '10'] };
  const by = commentaryByVerse('Genesis', data, [['  spaced  ']]);
  assert.deepEqual(by.get('Genesis 28:10'), ['spaced']);
});

// ─── storage ──────────────────────────────────────────────────────────────────

test('KV keys are in the v3 namespace, so v2 data written with bad refs is never read', () => {
  assert.equal(refToKvKey('Genesis 28:10'), 'insights:v3:Genesis:28:10');
  assert.equal(refToKvKey('I Samuel 3:4'), 'insights:v3:I Samuel:3:4');
});

// ─────────────────────────────────────────────────────────────────────────────

function pairsOf(pairs) {
  return { verses: pairs.map(p => p.verse), verseRefs: pairs.map(p => p.verseRef) };
}
