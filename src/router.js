/**
 * Request routing. Paths are matched by splitting the pathname — no regex route
 * table, because the shape of a json-server URL is fully described by "how many
 * segments" plus "is that resource a collection or a singular object".
 */
import {
  HttpError,
  methodNotAllowed,
  readJsonObject,
  sendJson,
} from './http-utils.js';
import { applyConditions, applyEmbed, applySort, paginate, parseQuery } from './query.js';

const ROOT_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const COLLECTION_METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS'];
const ITEM_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const SINGULAR_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'OPTIONS'];

/**
 * @typedef {object} RouteContext
 * @property {import('./store.js').Store} store
 * @property {string} method - HEAD already folded into GET
 * @property {URL} url
 * @property {object} options
 */

/**
 * Split a pathname into decoded segments.
 *
 * A trailing slash is insignificant, so `/posts/` and `/posts` are the same
 * route. Percent-decoding happens here so ids containing `/` or spaces survive.
 *
 * @param {string} pathname
 * @returns {string[]}
 */
export function decodeSegments(pathname) {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new HttpError(400, `Malformed percent-encoding in path segment "${segment}"`);
      }
    });
}

/**
 * Dispatch one request. Throws {@link HttpError} for anything the client got
 * wrong; the server turns that into a JSON error response.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {RouteContext} ctx
 * @returns {Promise<void>}
 */
export async function route(req, res, ctx) {
  const segments = decodeSegments(ctx.url.pathname);

  if (segments.length === 0) {
    if (ctx.method !== 'GET') methodNotAllowed(res, ROOT_METHODS);
    return sendResourceIndex(res, ctx);
  }
  if (segments.length > 2) {
    throw new HttpError(404, `No route for ${ctx.url.pathname}`);
  }

  const [name, id] = segments;
  if (!ctx.store.has(name)) {
    throw new HttpError(404, `No resource named "${name}"`);
  }

  if (ctx.store.isCollection(name)) {
    return id === undefined
      ? handleCollection(req, res, ctx, name)
      : handleItem(req, res, ctx, name, id);
  }

  if (id !== undefined) {
    throw new HttpError(404, `"${name}" is a singular resource and has no members`);
  }
  return handleSingular(req, res, ctx, name);
}

/**
 * `GET /` — a map of every resource to its URL, so the API is discoverable
 * without reading db.json.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {RouteContext} ctx
 */
function sendResourceIndex(res, ctx) {
  /** @type {Record<string, string>} */
  const index = {};
  for (const resource of ctx.store.resources()) {
    index[resource.name] = `/${encodeURIComponent(resource.name)}`;
  }
  sendJson(res, 200, index);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {RouteContext} ctx
 * @param {string} name
 */
async function handleCollection(req, res, ctx, name) {
  switch (ctx.method) {
    case 'GET':
      return sendJson(res, 200, readCollection(ctx, name));

    case 'POST': {
      const body = await readJsonObject(req);
      if (body.id !== undefined && body.id !== null && ctx.store.get(name, String(body.id))) {
        throw new HttpError(409, `${name} id "${body.id}" already exists`);
      }
      const created = ctx.store.create(name, body);
      await ctx.store.settled();
      return sendJson(res, 201, created, {
        Location: `/${encodeURIComponent(name)}/${encodeURIComponent(created.id)}`,
      });
    }

    default:
      return methodNotAllowed(res, COLLECTION_METHODS);
  }
}

/**
 * The read pipeline, in the order the contract fixes: filter, then sort, then
 * either paginate and embed into the envelope, or embed over the whole array.
 *
 * @param {RouteContext} ctx
 * @param {string} name
 * @returns {object[]|import('./query.js').Page}
 */
function readCollection(ctx, name) {
  const query = parseQuery(ctx.url.searchParams);
  const db = ctx.store.toJSON();

  const filtered = applyConditions(ctx.store.list(name), query.conditions);
  const sorted = applySort(filtered, query.sort);

  if (query.page === null || query.page === undefined) {
    return applyEmbed(sorted, query.embed, db, name);
  }

  const envelope = paginate(sorted, query.page, query.perPage);
  envelope.data = applyEmbed(envelope.data, query.embed, db, name);
  return envelope;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {RouteContext} ctx
 * @param {string} name
 * @param {string} id
 */
async function handleItem(req, res, ctx, name, id) {
  switch (ctx.method) {
    case 'GET':
      return sendJson(res, 200, requireItem(ctx, name, id));

    case 'PUT': {
      const body = await readJsonObject(req);
      const replaced = ctx.store.replace(name, id, body);
      if (replaced === null) throw notFound(name, id);
      await ctx.store.settled();
      return sendJson(res, 200, replaced);
    }

    case 'PATCH': {
      const body = await readJsonObject(req);
      const merged = ctx.store.merge(name, id, body);
      if (merged === null) throw notFound(name, id);
      await ctx.store.settled();
      return sendJson(res, 200, merged);
    }

    case 'DELETE': {
      const dependents = parseDependents(ctx);
      const removed = ctx.store.remove(name, id, { dependents });
      if (removed === null) throw notFound(name, id);
      await ctx.store.settled();
      return sendJson(res, 200, removed);
    }

    default:
      return methodNotAllowed(res, ITEM_METHODS);
  }
}

/**
 * Child collections to cascade a delete into. Accepts both repeated
 * (`?_dependent=a&_dependent=b`) and comma-separated (`?_dependent=a,b`) forms.
 *
 * @param {RouteContext} ctx
 * @returns {string[]}
 */
function parseDependents(ctx) {
  const dependents = ctx.url.searchParams
    .getAll('_dependent')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');

  for (const dependent of dependents) {
    if (!ctx.store.isCollection(dependent)) {
      throw new HttpError(400, `Unknown dependent collection "${dependent}"`);
    }
  }
  return dependents;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {RouteContext} ctx
 * @param {string} name
 */
async function handleSingular(req, res, ctx, name) {
  switch (ctx.method) {
    case 'GET':
      return sendJson(res, 200, ctx.store.getSingular(name));

    case 'PUT': {
      const body = await readJsonObject(req);
      const replaced = ctx.store.replaceSingular(name, body);
      await ctx.store.settled();
      return sendJson(res, 200, replaced);
    }

    case 'PATCH': {
      const body = await readJsonObject(req);
      const merged = ctx.store.mergeSingular(name, body);
      await ctx.store.settled();
      return sendJson(res, 200, merged);
    }

    default:
      return methodNotAllowed(res, SINGULAR_METHODS);
  }
}

/**
 * @param {RouteContext} ctx
 * @param {string} name
 * @param {string} id
 * @returns {object}
 */
function requireItem(ctx, name, id) {
  const item = ctx.store.get(name, id);
  if (item === null) throw notFound(name, id);
  return item;
}

/**
 * @param {string} name
 * @param {string} id
 * @returns {HttpError}
 */
function notFound(name, id) {
  return new HttpError(404, `No ${name} with id "${id}"`);
}
