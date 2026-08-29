/**
 * The HTTP server: cross-cutting concerns only. Everything request-specific
 * lives in the router, and the server never touches the database directly.
 */
import { createServer as createHttpServer } from 'node:http';
import { applyCors, HttpError, sendEmpty, sendError } from './http-utils.js';
import { createLogger } from './logger.js';
import { route } from './router.js';

/**
 * @typedef {object} ServerOptions
 * @property {import('./logger.js').Logger} [logger]
 */

/**
 * Build the server without starting it, so callers choose the port — including
 * the tests, which listen on port 0 and let the OS pick a free one.
 *
 * @param {import('./store.js').Store} store
 * @param {ServerOptions} [options]
 * @returns {import('node:http').Server}
 */
export function createServer(store, options = {}) {
  const logger = options.logger ?? createLogger({ quiet: true });

  return createHttpServer((req, res) => {
    handleRequest(req, res, store, options).catch((error) => {
      if (res.writableEnded) return;
      if (res.headersSent) {
        // The status line is already on the wire; the only honest signal left
        // is to break the response so the client does not trust a truncated body.
        logger.error(error);
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendError(res, error.status, error.message);
        return;
      }
      logger.error(error);
      sendError(res, 500, 'Internal server error');
    });
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./store.js').Store} store
 * @param {ServerOptions} options
 * @returns {Promise<void>}
 */
async function handleRequest(req, res, store, options) {
  applyCors(res);

  let url;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    throw new HttpError(400, 'Malformed request URL');
  }

  // Preflight is answered before routing: the browser is asking about the CORS
  // policy, which is uniform, not about whether the resource exists.
  if (req.method === 'OPTIONS') {
    return sendEmpty(res, 204);
  }

  if (req.method === 'HEAD') {
    suppressBody(res);
  }

  await route(req, res, {
    store,
    options,
    url,
    method: req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET'),
  });
}

/**
 * Make a response write its headers but no body.
 *
 * HEAD is defined as GET with the body dropped, so implementing it at the
 * transport edge means every route — and later gzip and ETag — get correct HEAD
 * support for free, with Content-Length still describing the body GET would
 * have returned.
 *
 * @param {import('node:http').ServerResponse} res
 */
function suppressBody(res) {
  const end = res.end.bind(res);
  res.write = () => true;
  res.end = (...args) => end(args.find((arg) => typeof arg === 'function'));
}
