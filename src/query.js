/* ==========================================================================
 * STUB — NOT THE REAL IMPLEMENTATION.
 *
 * src/query.js and test/query.test.js are owned by the other half of the team
 * and arrive on their own branch. This file exists only so the server runs end
 * to end before that branch merges, and it will be replaced wholesale — never
 * merged into, never extended here.
 *
 * The six exports below are the entire contract between the two halves. The
 * server may rely on their names, arguments and return shapes and on nothing
 * else: no extra exports, no internal helpers, no behaviour beyond this.
 *
 *   getPath(obj, path)
 *   parseQuery(searchParams) -> { conditions, sort, page, perPage, embed }
 *   applyConditions(items, conditions) -> array
 *   applySort(items, sortSpec) -> new array
 *   paginate(items, page, perPage) ->
 *       { first, prev, next, last, pages, items, data }
 *   applyEmbed(items, embedNames, db, resourceName) -> new array
 *
 * Stubbed behaviour: equality filtering only, no sorting, plain slice
 * pagination, no embedding.
 * ========================================================================== */

/** Page size used when `_per_page` is absent. */
export const DEFAULT_PER_PAGE = 10;

/**
 * Read a dot-separated path out of an object.
 *
 * @param {unknown} obj
 * @param {string} path
 * @returns {unknown}
 */
export function getPath(obj, path) {
  let current = obj;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * @typedef {object} Condition
 * @property {string} path
 * @property {string} operator
 * @property {string} value
 */

/**
 * @typedef {object} ParsedQuery
 * @property {Condition[]} conditions
 * @property {unknown} sort
 * @property {number|null} page - null when `_page` is absent
 * @property {number} perPage
 * @property {string[]} embed
 */

/**
 * Split a query string into filter, sort, pagination and embed instructions.
 *
 * @param {URLSearchParams} searchParams
 * @returns {ParsedQuery}
 */
export function parseQuery(searchParams) {
  /** @type {Condition[]} */
  const conditions = [];
  for (const [key, value] of searchParams) {
    if (key.startsWith('_')) continue; // reserved for operators
    conditions.push({ path: key, operator: 'eq', value });
  }

  const rawPage = searchParams.get('_page');
  const rawPerPage = searchParams.get('_per_page');
  const page = rawPage === null ? null : Number.parseInt(rawPage, 10) || 1;
  const perPage = rawPerPage === null ? DEFAULT_PER_PAGE : Number.parseInt(rawPerPage, 10) || DEFAULT_PER_PAGE;

  return {
    conditions,
    sort: null,
    page,
    perPage,
    embed: searchParams.getAll('_embed'),
  };
}

/**
 * @param {object[]} items
 * @param {Condition[]} conditions
 * @returns {object[]}
 */
export function applyConditions(items, conditions) {
  if (conditions.length === 0) return items.slice();
  return items.filter((item) =>
    conditions.every((condition) => String(getPath(item, condition.path)) === condition.value),
  );
}

/**
 * @param {object[]} items
 * @param {unknown} _sortSpec
 * @returns {object[]}
 */
export function applySort(items, _sortSpec) {
  return items.slice();
}

/**
 * @typedef {object} Page
 * @property {number} first
 * @property {number|null} prev
 * @property {number|null} next
 * @property {number} last
 * @property {number} pages - total number of pages
 * @property {number} items - total number of items across all pages
 * @property {object[]} data - the requested page
 */

/**
 * @param {object[]} items
 * @param {number} page
 * @param {number} perPage
 * @returns {Page}
 */
export function paginate(items, page, perPage) {
  const size = perPage > 0 ? perPage : DEFAULT_PER_PAGE;
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(page, 1), pages);
  const start = (current - 1) * size;

  return {
    first: 1,
    prev: current > 1 ? current - 1 : null,
    next: current < pages ? current + 1 : null,
    last: pages,
    pages,
    items: items.length,
    data: items.slice(start, start + size),
  };
}

/**
 * @param {object[]} items
 * @param {string[]} _embedNames
 * @param {Record<string, unknown>} _db
 * @param {string} _resourceName
 * @returns {object[]}
 */
export function applyEmbed(items, _embedNames, _db, _resourceName) {
  return items.slice();
}
