'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BadRequest,
  parseKey,
  parseParams,
  variantString,
  derivedKey,
} = require('../src/transform/params');

test('parseKey accepts nested keys and decodes them', () => {
  assert.equal(parseKey('photos/2026/cat.jpg'), 'photos/2026/cat.jpg');
  assert.equal(parseKey('/photos/my%20cat.PNG'), 'photos/my cat.PNG');
});

for (const bad of [
  '',
  undefined,
  '../secret.jpg',
  'a/../b.jpg',
  'a//b.jpg',
  './a.jpg',
  '%2e%2e/secret.jpg',
  'a%00.jpg',
  'notes.txt',
  'noextension',
  'bad%ZZ.jpg',
  `${'a/'.repeat(300)}x.jpg`,
]) {
  test(`parseKey rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(() => parseKey(bad), BadRequest);
  });
}

test('parseParams applies defaults and keeps the source format', () => {
  assert.deepEqual(parseParams(null, 'a.jpg'), {
    width: undefined,
    height: undefined,
    fit: 'cover',
    format: 'jpeg',
    quality: 80,
  });
  assert.equal(parseParams({}, 'a.png').format, 'png');
  assert.equal(parseParams({}, 'a.gif').format, 'png');
  assert.equal(parseParams({}, 'a.webp').format, 'webp');
});

test('parseParams reads all supported options', () => {
  const o = parseParams({ w: '300', h: '200', fit: 'contain', fmt: 'webp', q: '55' }, 'a.jpg');
  assert.deepEqual(o, { width: 300, height: 200, fit: 'contain', format: 'webp', quality: 55 });
});

for (const qs of [
  { w: '0' },
  { w: '4001' },
  { w: '-5' },
  { w: '1.5' },
  { w: 'abc' },
  { h: '999999' },
  { q: '0' },
  { q: '101' },
  { fit: 'stretch' },
  { fmt: 'bmp' },
  { evil: '1' },
]) {
  test(`parseParams rejects ${JSON.stringify(qs)}`, () => {
    assert.throws(() => parseParams(qs, 'a.jpg'), BadRequest);
  });
}

test('derivedKey is stable, order independent and sensitive to every option', () => {
  const a = parseParams({ w: '300', h: '200' }, 'a.jpg');
  const b = parseParams({ h: '200', w: '300' }, 'a.jpg');
  assert.equal(variantString(a), variantString(b));
  assert.equal(derivedKey('a.jpg', a), derivedKey('a.jpg', b));
  assert.match(derivedKey('a.jpg', a), /^v1\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/);

  const keys = new Set([
    derivedKey('a.jpg', a),
    derivedKey('b.jpg', a),
    derivedKey('a.jpg', parseParams({ w: '301', h: '200' }, 'a.jpg')),
    derivedKey('a.jpg', parseParams({ w: '300', h: '200', q: '70' }, 'a.jpg')),
    derivedKey('a.jpg', parseParams({ w: '300', h: '200', fit: 'fill' }, 'a.jpg')),
    derivedKey('a.jpg', parseParams({ w: '300', h: '200', fmt: 'webp' }, 'a.jpg')),
  ]);
  assert.equal(keys.size, 6);
});
