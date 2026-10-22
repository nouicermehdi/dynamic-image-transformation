'use strict';
/**
 * Request parsing and validation for the image transformation API.
 * No AWS or sharp dependency, so it is fast to unit test.
 *
 * URL contract:  /<s3-key>?w=<px>&h=<px>&fit=<mode>&fmt=<format>&q=<1-100>
 */
const crypto = require('node:crypto');

const FITS = ['cover', 'contain', 'fill', 'inside', 'outside'];
const FORMATS = ['jpeg', 'webp', 'avif', 'png'];
const KNOWN_PARAMS = new Set(['w', 'h', 'fit', 'fmt', 'q']);
const SOURCE_EXT = /\.(jpe?g|png|webp|avif|gif|tiff?)$/i;
const MAX_DIMENSION = 4000;
const MAX_KEY_LENGTH = 512;
const DEFAULT_QUALITY = 80;

const CONTENT_TYPES = {
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  png: 'image/png',
};
const FILE_EXTENSIONS = { jpeg: 'jpg', webp: 'webp', avif: 'avif', png: 'png' };

class BadRequest extends Error {}
class NotFound extends Error {}
class UnprocessableImage extends Error {}

/** Decode and validate the S3 object key taken from the URL path. */
function parseKey(rawPath) {
  let key;
  try {
    key = decodeURIComponent(rawPath || '');
  } catch {
    throw new BadRequest('Invalid path encoding');
  }
  key = key.replace(/^\/+/, '');
  if (!key || key.length > MAX_KEY_LENGTH || key.includes('\0')) {
    throw new BadRequest('Invalid image path');
  }
  // Reject traversal and empty segments ("a//b", "../x").
  if (key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new BadRequest('Invalid image path');
  }
  if (!SOURCE_EXT.test(key)) {
    throw new BadRequest('Unsupported file type');
  }
  return key;
}

function intParam(qs, name, max) {
  const value = qs[name];
  if (value === undefined || value === '') return undefined;
  if (!/^\d{1,5}$/.test(value)) throw new BadRequest(`${name} must be a positive integer`);
  const n = Number(value);
  if (n < 1 || n > max) throw new BadRequest(`${name} must be between 1 and ${max}`);
  return n;
}

/** Output format used when the caller does not ask for one. */
function defaultFormat(key) {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'webp') return 'webp';
  if (ext === 'avif') return 'avif';
  return 'png'; // png, gif, tiff
}

function parseParams(queryString, key) {
  const qs = queryString || {};
  for (const name of Object.keys(qs)) {
    if (!KNOWN_PARAMS.has(name)) throw new BadRequest(`Unknown parameter: ${name}`);
  }
  const fit = qs.fit === undefined ? 'cover' : qs.fit;
  if (!FITS.includes(fit)) throw new BadRequest(`fit must be one of: ${FITS.join(', ')}`);
  const fmt = qs.fmt === undefined || qs.fmt === '' ? defaultFormat(key) : qs.fmt;
  if (!FORMATS.includes(fmt)) throw new BadRequest(`fmt must be one of: ${FORMATS.join(', ')}`);
  const quality = intParam(qs, 'q', 100) ?? DEFAULT_QUALITY;
  return {
    width: intParam(qs, 'w', MAX_DIMENSION),
    height: intParam(qs, 'h', MAX_DIMENSION),
    fit,
    format: fmt,
    quality,
  };
}

/** Canonical text form of a variant, independent of query parameter order. */
function variantString(opts) {
  return `w=${opts.width ?? ''}&h=${opts.height ?? ''}&fit=${opts.fit}&fmt=${opts.format}&q=${opts.quality}`;
}

/** Object key of the stored result in the derived bucket. */
function derivedKey(key, opts) {
  const hash = crypto.createHash('sha256').update(`${key}|${variantString(opts)}`).digest('hex');
  return `v1/${hash.slice(0, 2)}/${hash}.${FILE_EXTENSIONS[opts.format]}`;
}

module.exports = {
  FITS,
  FORMATS,
  CONTENT_TYPES,
  MAX_DIMENSION,
  BadRequest,
  NotFound,
  UnprocessableImage,
  parseKey,
  parseParams,
  variantString,
  derivedKey,
};
