const test = require('node:test');
const assert = require('node:assert/strict');
const { PHRASES, EXACT_PHRASES, scoreKeywords, normalize, passesThreshold, KW_HIDE } = require('../extension/scorer-keywords.js');

test('normalize lowercases, collapses whitespace, strips trailing punctuation', () => {
  assert.equal(normalize('  Great   INSIGHT!!! '), 'great insight');
  assert.equal(normalize('So true…'), 'so true');
});

test('emoji-only and punctuation-only replies hide', () => {
  for (const t of ['🔥', '🔥🔥🔥', '👏 👏', '!!!', '💯🙌', '...', '👆']) {
    assert.equal(scoreKeywords(t), 'hide', t);
  }
});

test('every phrase hides on its own and in a short reply', () => {
  for (const p of PHRASES) {
    assert.equal(scoreKeywords(p), 'hide', `bare: ${p}`);
    assert.equal(scoreKeywords(`${p.toUpperCase()}! 🔥`), 'hide', `shouted: ${p}`);
    assert.equal(scoreKeywords(`Wow, ${p} man, thanks`), 'hide', `short: ${p}`);
  }
});

test('exact phrases hide only as the whole reply', () => {
  for (const p of EXACT_PHRASES) assert.equal(scoreKeywords(p), 'hide', p);
  assert.notEqual(scoreKeywords('this is wrong, the paper was retracted last spring'), 'hide');
});

test('phrases match whole words only', () => {
  assert.notEqual(scoreKeywords('artifacts from the build'), 'hide');
});

test('long replies keep, even with a phrase', () => {
  const long = 'Great post, although I think the part about hiring misses how early teams actually work when nobody has a title and everyone ships';
  assert.equal(scoreKeywords(long), 'keep');
});

test('replies with a number keep', () => {
  assert.equal(scoreKeywords('We cut churn by 12 points doing this'), 'keep');
  assert.equal(scoreKeywords('Great post! Our revenue grew 40% after we tried it'), 'keep');
});

test('replies with a link or code keep', () => {
  assert.equal(scoreKeywords('wrote about this here https://example.com/post'), 'keep');
  assert.equal(scoreKeywords('see example.dev for the writeup'), 'keep');
  assert.equal(scoreKeywords('just use `git bisect` for that'), 'keep');
});

test('questions keep at 6+ words, short ones are unsure', () => {
  assert.equal(scoreKeywords('How did you handle the migration without downtime?'), 'keep');
  assert.equal(scoreKeywords('Source?'), 'unsure');
  assert.equal(scoreKeywords('why though?'), 'unsure');
});

test('ambiguous short replies are unsure', () => {
  assert.equal(scoreKeywords('This changes how I think about onboarding'), 'unsure');
});

test('pure filler hides even when it contains a number', () => {
  assert.equal(scoreKeywords('100%'), 'hide');
  assert.equal(scoreKeywords('facts 💯 100%'), 'hide');
});

test('empty text is kept', () => {
  assert.equal(scoreKeywords(''), 'keep');
  assert.equal(scoreKeywords('   '), 'keep');
});

test('thresholds follow strictness', () => {
  const v = { score: 1.5, confidence: 0.65 };
  assert.equal(passesThreshold(v, 'low'), false);
  assert.equal(passesThreshold(v, 'medium'), true);
  assert.equal(passesThreshold(v, 'high'), true);
  assert.equal(passesThreshold(KW_HIDE, 'low'), true);
});
