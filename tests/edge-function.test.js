'use strict';
/**
 * Tests the CloudFront Function that is embedded in template.yaml by extracting
 * the exact code between the BEGIN/END markers, so the test cannot drift from
 * what is deployed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadEdgeHandler() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'template.yaml'), 'utf8');
  const match = text.match(/# BEGIN edge-function\n([\s\S]*?)\s*# END edge-function/);
  assert.ok(match, 'edge-function markers not found in template.yaml');
  const lines = match[1].split('\n').filter((l) => l.trim() !== '');
  const indent = Math.min(...lines.map((l) => l.match(/^ */)[0].length));
  let code = lines.map((l) => l.slice(indent)).join('\n');
  code = code.replace(/^FunctionCode: \|\n/, '');
  const inner = code.split('\n');
  const innerIndent = Math.min(...inner.map((l) => l.match(/^ */)[0].length));
  code = inner.map((l) => l.slice(innerIndent)).join('\n');
  return new Function(`${code}\nreturn handler;`)();
}

const handler = loadEdgeHandler();
const run = (accept, querystring = {}) =>
  handler({
    request: {
      headers: accept === undefined ? {} : { accept: { value: accept } },
      querystring,
    },
  }).querystring;

test('browsers that accept AVIF get avif', () => {
  assert.deepEqual(run('image/avif,image/webp,image/*;q=0.8').fmt, { value: 'avif' });
});

test('browsers that accept only WebP get webp', () => {
  assert.deepEqual(run('image/webp,image/apng,image/*').fmt, { value: 'webp' });
});

test('clients without modern formats keep the source format (no fmt added)', () => {
  assert.equal(run('image/png,*/*').fmt, undefined);
  assert.equal(run(undefined).fmt, undefined);
});

test('an explicit fmt is never overridden', () => {
  assert.deepEqual(run('image/avif', { fmt: { value: 'png' } }).fmt, { value: 'png' });
});

test('other query parameters are preserved', () => {
  const qs = run('image/webp', { w: { value: '300' } });
  assert.deepEqual(qs.w, { value: '300' });
  assert.deepEqual(qs.fmt, { value: 'webp' });
});
