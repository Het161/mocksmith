/**
 * HTTP primitives: error signalling, CORS, request-body reading and response
 * helpers. This module imports nothing of ours and knows nothing about the
 * database — everything above it is free to depend on it.
 */

/** Largest request body we will accept, in bytes. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * An error that carries the status code it should be reported with. Anything
 * else escaping a handler is a bug and becomes a 500.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    /** @type {number} */
    this.status = status;
  }
}

/**
 * CORS headers sent on every response.
 *
 * A mock API's whole job is to be called from a front-end running on a
 * different port, so the permissive policy is the correct one here — and it is
 * safe precisely because the server holds no credentials and no session.
 */
export const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, If-None-Match',
  'Access-Control-Expose-Headers': 'Location, Link, X-Total-Count, ETag',
  'Access-Control-Max-Age': '86400',
});

/**
 * @param {import('node:http').ServerResponse} res
 */
export function applyCors(res) {
  for (const [header, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(header, value);
  }
}

/**
 * Send a JSON response with an accurate Content-Length.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string|number>} [headers]
 */
export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    ...headers,
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
export function sendError(res, status, message) {
  sendJson(res, status, { error: { message } });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} [status]
 * @param {Record<string, string|number>} [headers]
 */
export function sendEmpty(res, status = 204, headers = {}) {
  res.writeHead(status, headers);
  res.end();
}

/**
 * Reject a request whose method does not apply to the matched route.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string[]} allowed
 * @returns {never}
 */
export function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  throw new HttpError(405, `Method not allowed; try ${allowed.join(', ')}`);
}

/**
 * Read and parse a JSON request body.
 *
 * Once the limit is passed we stop buffering but keep draining the stream, then
 * reject. Destroying the socket mid-upload would be cheaper, but the client
 * would see a connection reset instead of the 413 that explains what happened;
 * memory stays bounded either way, which is the property that matters.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?: number}} [options]
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json\s*(?:;|$)/i.test(contentType.trim())) {
    throw new HttpError(415, 'Request body must be sent as application/json');
  }

  /** @type {Buffer[]} */
  let chunks = [];
  let size = 0;
  let tooLarge = false;

  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > limit) {
      tooLarge = true;
      chunks = [];
      continue;
    }
    chunks.push(chunk);
  }

  if (tooLarge) {
    throw new HttpError(413, `Request body exceeds the ${limit} byte limit`);
  }
  if (size === 0) {
    throw new HttpError(400, 'Request body is empty; expected a JSON object');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new HttpError(400, `Request body is not valid JSON: ${error.message}`);
  }
}

/**
 * Read a body that must be a JSON object — the shape every write endpoint
 * accepts. An array or a bare literal is a client mistake, not a resource.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?: number}} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonObject(req, options) {
  const body = await readJsonBody(req, options);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return /** @type {Record<string, unknown>} */ (body);
}
