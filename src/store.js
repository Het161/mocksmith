/**
 * The database. An in-memory JavaScript object is the single source of truth;
 * the file on disk is a projection of it that persistence keeps up to date.
 *
 * The store knows nothing about HTTP. It reports misses by returning `null`
 * and rejects genuinely broken input by throwing {@link DatabaseError}; the
 * router is what turns either of those into a status code.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Characters used for generated ids: base36, URL-safe, easy to read aloud. */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * 252 is the largest multiple of 36 that fits in a byte. Rejecting bytes at or
 * above it keeps every character equally likely; a bare `byte % 36` would make
 * the first four characters of the alphabet ~14% more common than the rest.
 */
const ID_REJECTION_LIMIT = 252;

/** Length of a generated id. Short enough to type, wide enough to not collide. */
const ID_LENGTH = 6;

/**
 * Guard against a pathological loop if `randomBytes` ever returned a constant.
 * A real collision at 36^6 combinations is vanishingly unlikely.
 */
const ID_MAX_ATTEMPTS = 100;

/** Raised when db.json cannot be loaded or a mutation would corrupt it. */
export class DatabaseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DatabaseError';
  }
}

/**
 * True for objects that came from `JSON.parse` and are not arrays.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Generate a random id using unbiased rejection sampling over {@link ID_ALPHABET}.
 *
 * @param {number} [length]
 * @returns {string}
 */
export function generateId(length = ID_LENGTH) {
  let id = '';
  while (id.length < length) {
    for (const byte of randomBytes(length - id.length)) {
      if (byte >= ID_REJECTION_LIMIT) continue;
      id += ID_ALPHABET[byte % ID_ALPHABET.length];
    }
  }
  return id;
}

/**
 * Derive the foreign-key prefix for a collection: `comments` -> `comment`, so a
 * child of `posts` is matched on `postId`.
 *
 * Deliberately naive — a real inflector is a dependency-shaped problem, and
 * irregular plurals (`people` -> `peopleId`) are documented as unsupported.
 *
 * @param {string} name
 * @returns {string}
 */
export function singularize(name) {
  return name.length > 1 && name.endsWith('s') ? name.slice(0, -1) : name;
}

/**
 * Coerce an id to its canonical string form.
 *
 * Ids are normalised exactly once, here at the boundary, so nothing downstream
 * ever has to guess whether `/posts/1` should match `1` or `"1"`.
 *
 * @param {unknown} id
 * @param {string} where - human-readable location, used in the error message
 * @returns {string}
 */
export function coerceId(id, where) {
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  throw new DatabaseError(`${where}: id must be a string or a number, got ${typeof id}`);
}

/**
 * Validate a parsed db.json and normalise it in place: every collection item
 * ends up with a unique string id.
 *
 * Fails fast and loudly — a mock server that silently "fixes" a malformed
 * database teaches its user the wrong thing about their fixtures.
 *
 * @param {unknown} raw - freshly parsed JSON; mutated in place
 * @returns {Record<string, unknown>} the same object, normalised
 */
export function normaliseDatabase(raw) {
  if (!isPlainObject(raw)) {
    throw new DatabaseError(
      `Database root must be a JSON object of resources, got ${Array.isArray(raw) ? 'an array' : typeof raw}`,
    );
  }

  for (const [name, value] of Object.entries(raw)) {
    if (isPlainObject(value)) continue; // singular resource: nothing to normalise
    if (!Array.isArray(value)) {
      throw new DatabaseError(
        `Resource "${name}" must be an array (collection) or an object (singular), got ${typeof value}`,
      );
    }

    const seen = new Set();
    value.forEach((item, index) => {
      if (!isPlainObject(item)) {
        throw new DatabaseError(`Collection "${name}" item at index ${index} must be an object`);
      }
      const id =
        item.id === undefined || item.id === null
          ? generateId()
          : coerceId(item.id, `Collection "${name}" item at index ${index}`);
      if (seen.has(id)) {
        throw new DatabaseError(`Collection "${name}" has duplicate id "${id}"`);
      }
      seen.add(id);
      item.id = id;
    });
  }

  return raw;
}

/**
 * @typedef {object} ChangeEvent
 * @property {string} resource
 * @property {'create'|'update'|'delete'} action
 * @property {string|null} id - null for singular resources, which have no id
 * @property {object|null} data
 */

/**
 * @typedef {object} ResourceInfo
 * @property {string} name
 * @property {'collection'|'singular'} type
 * @property {number} count
 */

export class Store {
  /** @type {Record<string, unknown>} */
  #data;
  /** @type {string} */
  #file;
  /** @type {Set<(event: ChangeEvent) => void>} */
  #listeners = new Set();

  /**
   * @param {unknown} data - parsed db.json
   * @param {string} file - path the data came from
   */
  constructor(data, file) {
    this.#data = normaliseDatabase(data);
    this.#file = file;
  }

  /**
   * Read and validate a database file.
   *
   * @param {string} file
   * @returns {Promise<Store>}
   */
  static async load(file) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      throw new DatabaseError(`Cannot read database file ${file}: ${error.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new DatabaseError(`${file} is not valid JSON: ${error.message}`);
    }

    return new Store(parsed, file);
  }

  /** Path the database was loaded from. @returns {string} */
  get file() {
    return this.#file;
  }

  /**
   * The live database object. Exposed for serialisation and for `_embed`
   * lookups; callers must treat it as read-only.
   *
   * @returns {Record<string, unknown>}
   */
  toJSON() {
    return this.#data;
  }

  /**
   * Subscribe to mutations. This is the single seam the WebSocket broadcaster
   * hooks into, so nothing outside the store ever inspects its internals.
   *
   * @param {(event: ChangeEvent) => void} listener
   * @returns {() => void} unsubscribe
   */
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Resolves once it is safe to respond to a mutating request.
   *
   * With debounced persistence (the default) that is immediately: the in-memory
   * object is already authoritative. Under `--sync` it waits for the write to
   * reach disk. Keeping the decision here means the router awaits the same call
   * either way.
   *
   * @returns {Promise<void>}
   */
  async settled() {
    // Memory-only until the persistence layer lands.
  }

  /**
   * Flush pending writes and release resources.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this.#listeners.clear();
  }

  /** @returns {ResourceInfo[]} */
  resources() {
    return Object.entries(this.#data).map(([name, value]) =>
      Array.isArray(value)
        ? { name, type: /** @type {const} */ ('collection'), count: value.length }
        : { name, type: /** @type {const} */ ('singular'), count: 1 },
    );
  }

  /**
   * `Object.hasOwn` rather than a property read, so `/__proto__` or
   * `/constructor` cannot resolve to something off the prototype chain.
   *
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return Object.hasOwn(this.#data, name);
  }

  /** @param {string} name @returns {boolean} */
  isCollection(name) {
    return this.has(name) && Array.isArray(this.#data[name]);
  }

  /** @param {string} name @returns {boolean} */
  isSingular(name) {
    return this.has(name) && !Array.isArray(this.#data[name]);
  }

  /**
   * Items of a collection. The live array — the read pipeline copies before it
   * sorts, and no caller mutates it.
   *
   * @param {string} name
   * @returns {object[]}
   */
  list(name) {
    return this.#collection(name);
  }

  /**
   * @param {string} name
   * @param {string} id
   * @returns {object|null}
   */
  get(name, id) {
    return this.#collection(name).find((item) => item.id === id) ?? null;
  }

  /**
   * Append an item, generating an id when the body does not carry one.
   *
   * @param {string} name
   * @param {object} input
   * @returns {object} the stored item
   */
  create(name, input) {
    const items = this.#collection(name);
    const id =
      input.id === undefined || input.id === null
        ? this.#freshId(items)
        : coerceId(input.id, `POST /${name}`);
    const item = { ...input, id };
    items.push(item);
    this.#emit(name, 'create', id, item);
    return item;
  }

  /**
   * Replace an item wholesale. The id always comes from the URL, never from the
   * body, so a PUT can never re-key a record.
   *
   * @param {string} name
   * @param {string} id
   * @param {object} input
   * @returns {object|null} null when the item does not exist
   */
  replace(name, id, input) {
    const items = this.#collection(name);
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const item = { ...input, id };
    items[index] = item;
    this.#emit(name, 'update', id, item);
    return item;
  }

  /**
   * Shallow-merge a patch into an item.
   *
   * @param {string} name
   * @param {string} id
   * @param {object} input
   * @returns {object|null} null when the item does not exist
   */
  merge(name, id, input) {
    const items = this.#collection(name);
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const item = { ...items[index], ...input, id };
    items[index] = item;
    this.#emit(name, 'update', id, item);
    return item;
  }

  /**
   * Delete an item, optionally cascading to child collections whose
   * `<singular>Id` points at it.
   *
   * @param {string} name
   * @param {string} id
   * @param {{dependents?: string[]}} [options]
   * @returns {object|null} the deleted item, or null when it did not exist
   */
  remove(name, id, { dependents = [] } = {}) {
    const items = this.#collection(name);
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return null;

    const [removed] = items.splice(index, 1);
    this.#emit(name, 'delete', id, removed);

    const foreignKey = `${singularize(name)}Id`;
    for (const dependent of dependents) {
      const children = this.#collection(dependent);
      // Iterate backwards so splicing does not skip the next match.
      for (let i = children.length - 1; i >= 0; i -= 1) {
        if (children[i][foreignKey] === undefined) continue;
        if (coerceId(children[i][foreignKey], `${dependent}.${foreignKey}`) !== id) continue;
        const [child] = children.splice(i, 1);
        this.#emit(dependent, 'delete', child.id, child);
      }
    }

    return removed;
  }

  /**
   * @param {string} name
   * @returns {object|null}
   */
  getSingular(name) {
    return this.isSingular(name) ? /** @type {object} */ (this.#data[name]) : null;
  }

  /**
   * @param {string} name
   * @param {object} input
   * @returns {object}
   */
  replaceSingular(name, input) {
    const next = { ...input };
    this.#data[name] = next;
    this.#emit(name, 'update', null, next);
    return next;
  }

  /**
   * @param {string} name
   * @param {object} input
   * @returns {object}
   */
  mergeSingular(name, input) {
    const next = { ...this.getSingular(name), ...input };
    this.#data[name] = next;
    this.#emit(name, 'update', null, next);
    return next;
  }

  /**
   * @param {string} name
   * @returns {object[]}
   */
  #collection(name) {
    if (!this.isCollection(name)) {
      throw new DatabaseError(`"${name}" is not a collection`);
    }
    return /** @type {object[]} */ (this.#data[name]);
  }

  /**
   * @param {object[]} items
   * @returns {string}
   */
  #freshId(items) {
    for (let attempt = 0; attempt < ID_MAX_ATTEMPTS; attempt += 1) {
      const id = generateId();
      if (!items.some((item) => item.id === id)) return id;
    }
    throw new DatabaseError('Could not generate a unique id');
  }

  /**
   * @param {string} resource
   * @param {'create'|'update'|'delete'} action
   * @param {string|null} id
   * @param {object|null} data
   */
  #emit(resource, action, id, data) {
    for (const listener of this.#listeners) {
      listener({ resource, action, id, data });
    }
  }
}
