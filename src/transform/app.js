'use strict';
/**
 * Lambda behind API Gateway (proxy integration). For each request it:
 *   1. validates the path and query string,
 *   2. returns a previously generated result from the derived bucket if one exists,
 *   3. otherwise reads the original from the source bucket, transforms it with sharp,
 *      stores the result in the derived bucket and returns it.
 *
 * CloudFront caches the response at the edge, so this code only runs on a
 * CloudFront miss; the derived bucket makes a miss in a different edge location
 * (or after expiry) cheap, because no pixels are processed twice.
 */
const {
  CONTENT_TYPES,
  BadRequest,
  NotFound,
  UnprocessableImage,
  parseKey,
  parseParams,
  derivedKey,
} = require('./params');

// API Gateway returns binary bodies base64 encoded, and a Lambda response is
// limited to 6 MiB. Base64 adds 33%, so the raw image must stay below about 4.5 MB.
const MAX_RESPONSE_BYTES = 4_400_000;

function createHandler(deps, config = {}) {
  const maxBytes = config.maxResponseBytes || MAX_RESPONSE_BYTES;
  const browserCacheSeconds = config.browserCacheSeconds ?? 86400;
  const log = config.log || console;

  const jsonReply = (statusCode, message, cacheControl) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify({ message }),
  });

  const imageReply = (buffer, contentType, origin) => ({
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${browserCacheSeconds}`,
      'X-Content-Type-Options': 'nosniff',
      'X-Image-Origin': origin,
    },
    body: buffer.toString('base64'),
  });

  return async function handler(event) {
    try {
      const method = event.httpMethod || 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        return jsonReply(405, 'Method not allowed', 'no-store');
      }

      const key = parseKey(event.pathParameters && event.pathParameters.key);
      const opts = parseParams(event.queryStringParameters, key);
      const contentType = CONTENT_TYPES[opts.format];
      const dKey = derivedKey(key, opts);

      const stored = await deps.getDerived(dKey);
      if (stored) {
        log.info(JSON.stringify({ event: 'image', result: 'derived-hit', key }));
        return imageReply(stored, contentType, 'derived-cache');
      }

      const source = await deps.getSource(key);
      if (!source) throw new NotFound('Image not found');

      const output = await deps.transform(source, opts);
      if (output.length > maxBytes) {
        return jsonReply(
          413,
          'Result is too large to return. Request a smaller size or lower quality.',
          'public, max-age=60',
        );
      }

      await deps.putDerived(dKey, output, contentType);
      log.info(JSON.stringify({ event: 'image', result: 'generated', key, bytes: output.length }));
      return imageReply(output, contentType, 'generated');
    } catch (err) {
      if (err instanceof BadRequest) return jsonReply(400, err.message, 'public, max-age=60');
      if (err instanceof NotFound) return jsonReply(404, err.message, 'public, max-age=60');
      if (err instanceof UnprocessableImage) {
        return jsonReply(422, 'The source file could not be processed as an image', 'public, max-age=60');
      }
      log.error(err); // details stay in CloudWatch, never in the response
      return jsonReply(500, 'Internal server error', 'no-store');
    }
  };
}

/** Real AWS and sharp dependencies, created on first use (cold start only). */
function realDeps() {
  const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const sharp = require('sharp');
  const s3 = new S3Client({});
  const sourceBucket = process.env.SOURCE_BUCKET;
  const derivedBucket = process.env.DERIVED_BUCKET;

  async function read(bucket, key) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (err.name === 'NoSuchKey') return null;
      throw err;
    }
  }

  return {
    getSource: (key) => read(sourceBucket, key),
    getDerived: (key) => read(derivedBucket, key),
    putDerived: (key, body, contentType) =>
      s3.send(
        new PutObjectCommand({
          Bucket: derivedBucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      ),
    async transform(input, o) {
      try {
        let img = sharp(input, { limitInputPixels: 50_000_000 }).rotate(); // honour EXIF orientation
        if (o.width || o.height) {
          img = img.resize({
            width: o.width,
            height: o.height,
            fit: o.fit,
            withoutEnlargement: true,
          });
        }
        if (o.format === 'jpeg') img = img.jpeg({ quality: o.quality, mozjpeg: true });
        else if (o.format === 'webp') img = img.webp({ quality: o.quality });
        else if (o.format === 'avif') img = img.avif({ quality: o.quality, effort: 2 });
        else img = img.png({ compressionLevel: 9 });
        return await img.toBuffer();
      } catch (err) {
        throw new UnprocessableImage(err.message);
      }
    },
  };
}

let cachedHandler;
exports.handler = (event, context) => {
  if (!cachedHandler) {
    cachedHandler = createHandler(realDeps(), {
      browserCacheSeconds: Number(process.env.BROWSER_CACHE_SECONDS || 86400),
    });
  }
  return cachedHandler(event, context);
};
exports.createHandler = createHandler;
