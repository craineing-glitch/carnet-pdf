import test from 'node:test';
import assert from 'node:assert/strict';

const model = await import('../src/review-model.js').catch(() => null);

test('page input accepts noncontiguous ranges and Chinese punctuation in original page order', () => {
  assert.ok(model, 'Review page-selection model is available');
  assert.deepEqual(model.parsePageSelection('5，２－３; 2、1', 5), [1, 2, 3, 5]);
  assert.deepEqual(model.parsePageSelection(' 4 ', 8), [4]);
  assert.equal(model.formatPageList([1, 2, 3, 5, 7, 8]), '1-3, 5, 7-8');
});

test('invalid, backwards and out-of-range pages cannot silently collect the wrong article', () => {
  assert.ok(model, 'Review page-selection model is available');
  for (const input of ['', '0', '-2', '4-2', '2.5', '1,9', '1-1000000', '1,word']) {
    assert.throws(() => model.parsePageSelection(input, 8), /页码|选择/);
  }
});

test('review shelf excludes originals and trash and sorts by collection time independent of names', () => {
  assert.ok(model, 'Review shelf model is available');
  const documents = [
    {id:'old',name:'Z article',review:{collectedAt:'2026-10-11T10:00:00Z'}},
    {id:'source',name:'article'},
    {id:'trash',name:'article',deletedAt:'2026-10-13T10:00:00Z',review:{collectedAt:'2026-10-13T10:00:00Z'}},
    {id:'new',name:'A article',review:{collectedAt:'2026-10-12T10:00:00Z'}},
  ];
  assert.deepEqual(model.reviewEntries(documents).map(d=>d.id), ['new','old']);
  assert.deepEqual(model.reviewEntries(documents,'Z ARTICLE').map(d=>d.id), ['old']);
});
