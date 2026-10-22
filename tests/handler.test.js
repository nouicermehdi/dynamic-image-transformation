'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../src/transform/app');
const { UnprocessableImage } = require('../src/transform/params');

const silent = { info() {}, error() {} };

function setup({ sources = { 'cat.jpg': Buffer.from('ORIGINAL') }, transform, maxResponseBytes } = {}) {
  const derived = new Map();
  const calls = { transform: 0, source: 0, put: 0 };
  const deps = {
    async getSource(key) {
      calls.source += 1;
      return sources[key] || null;
    },
    async getDerived(key) {
      return derived.get(key) || null;
    },
    async putDerived(key, body) {
      calls.put += 1;
      derived.set(key, body);
    },
    async transform(buf, opts) {
      calls.transform += 1;
      if (transform) return transform(buf, opts);
      return Buffer.from(`T[${buf.toString()}|${opts.width}x${opts.height}|${opts.format}]`);
    },
  };
  const handler = createHandler(deps, { log: silent, browserCacheSeconds: 3600, maxResponseBytes });
  return { handler, calls, derived };
}

const get = (key, qs, method = 'GET') => ({
  httpMethod: method,
  pathParameters: { key },
  queryStringParameters: qs || null,
});

test('generates, stores and returns a transformed image', async () => {
  const { handler, calls, derived } = setup();
  const res = await handler(get('cat.jpg', { w: '300', h: '200' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.isBase64Encoded, true);
  assert.equal(Buffer.from(res.body, 'base64').toString(), 'T[ORIGINAL|300x200|jpeg]');
  assert.equal(res.headers['Content-Type'], 'image/jpeg');
  assert.equal(res.headers['Cache-Control'], 'public, max-age=3600');
  assert.equal(res.headers['X-Image-Origin'], 'generated');
  assert.equal(calls.put, 1);
  assert.equal(derived.size, 1);
});

test('second identical request is served from the derived bucket without reprocessing', async () => {
  const { handler, calls } = setup();
  await handler(get('cat.jpg', { w: '300' }));
  const again = await handler(get('cat.jpg', { w: '300' }));
  assert.equal(again.statusCode, 200);
  assert.equal(again.headers['X-Image-Origin'], 'derived-cache');
  assert.equal(calls.transform, 1);
  assert.equal(calls.source, 1);
});

test('different parameters create separate results', async () => {
  const { handler, calls } = setup();
  await handler(get('cat.jpg', { w: '300' }));
  await handler(get('cat.jpg', { w: '300', fmt: 'webp' }));
  assert.equal(calls.transform, 2);
});

test('fmt controls the content type', async () => {
  const { handler } = setup();
  const res = await handler(get('cat.jpg', { fmt: 'avif' }));
  assert.equal(res.headers['Content-Type'], 'image/avif');
});

test('HEAD is allowed, other methods are not', async () => {
  const { handler } = setup();
  assert.equal((await handler(get('cat.jpg', null, 'HEAD'))).statusCode, 200);
  assert.equal((await handler(get('cat.jpg', null, 'POST'))).statusCode, 405);
});

test('missing source returns 404 and does not write anything', async () => {
  const { handler, calls } = setup();
  const res = await handler(get('nope.jpg', { w: '100' }));
  assert.equal(res.statusCode, 404);
  assert.equal(calls.put, 0);
});

test('invalid input returns 400 before touching S3', async () => {
  const { handler, calls } = setup();
  for (const [key, qs] of [
    ['../cat.jpg', {}],
    ['cat.jpg', { w: '99999' }],
    ['cat.jpg', { fmt: 'bmp' }],
    ['cat.txt', {}],
  ]) {
    const res = await handler(get(key, qs));
    assert.equal(res.statusCode, 400, `${key} ${JSON.stringify(qs)}`);
    assert.equal(JSON.parse(res.body).message.length > 0, true);
  }
  assert.equal(calls.source, 0);
});

test('oversized result returns 413 and is not stored', async () => {
  const { handler, calls } = setup({ transform: () => Buffer.alloc(100), maxResponseBytes: 50 });
  const res = await handler(get('cat.jpg'));
  assert.equal(res.statusCode, 413);
  assert.equal(calls.put, 0);
});

test('corrupt source returns 422', async () => {
  const { handler } = setup({
    transform: () => {
      throw new UnprocessableImage('bad bytes');
    },
  });
  const res = await handler(get('cat.jpg'));
  assert.equal(res.statusCode, 422);
  assert.doesNotMatch(res.body, /bad bytes/);
});

test('unexpected failures return a generic 500 and are not cached', async () => {
  const { handler } = setup({
    transform: () => {
      throw new Error('S3 secret ARN arn:aws:s3:::internal');
    },
  });
  const res = await handler(get('cat.jpg'));
  assert.equal(res.statusCode, 500);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(res.body, /arn:/);
});
