/**
 * The database. An in-memory JavaScript object is the single source of truth;
 * the file on disk is a projection of it that persistence keeps up to date.
 *
 * The store knows nothing about HTTP. It reports misses by returning `null`
 * and rejects genuinely broken input by throwing {@link DatabaseError}; the
 * router is what turns either of those into a status code.
 *
 * Durability model
 * ----------------
 * Every mutation marks the store dirty. Writes are debounced (~100ms) and run
 * through a queue that guarantees only one write touches the file at a time.
 * Each write is atomic: a temp file in the same directory, fsync'd, then
 * renamed over the target. A reader therefore sees either the whole previous
 * database or the whole next one — never half of either.
 */
import { createHash, randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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

/**
 * How long to coalesce mutations before writing. Long enough that a burst of
 * requests costs one fsync, short enough that a human never notices the file
 * lagging behind the API.
 */
const DEFAULT_DEBOUNCE_MS = 100;

/**
 * Editors save in bursts — truncate, write, rename — and each step raises its
 * own event. Coalescing them means one reload per save, not three.
 */
const RELOAD_DEBOUNCE_MS = 50;

/** Distinguishes temp files from concurrent processes writing the same db. */
let tempFileCounter = 0;

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
 * Serialise the database the way it is written to disk. Pretty-printed with a
 * trailing newline, because db.json is a file humans open and edit.
 *
 * @param {Record<string, unknown>} data
 * @returns {string}
 */
export function serialiseDatabase(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
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
 * @param {string} text
 * @returns {string}
 */
function hashText(text) {
  return createHash('sha1').update(text).digest('hex');
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

/**
 * @typedef {object} StoreOptions
 * @property {boolean} [sync] - wait for each write to reach disk
 * @property {boolean} [watch] - reload when the file is edited externally
 * @property {number} [debounceMs]
 * @property {(error: Error) => void} [onError] - background failure reporter
 */

export class Store {
  /** @type {Record<string, unknown>} */
  #data;
  /** @type {string} */
  #file;
  /** @type {Set<(event: ChangeEvent) => void>} */
  #listeners = new Set();
  /** @type {Set<() => void>} */
  #reloadListeners = new Set();
  /** @type {(error: Error) => void} */
  #onError;

  /** True when memory holds changes that are not on disk yet. */
  #dirty = false;
  #sync;
  #debounceMs;
  /** @type {NodeJS.Timeout|null} */
  #writeTimer = null;
  /**
   * Tail of the write queue. Every write chains onto it, which is what makes
   * "one writer at a time" true no matter how many requests arrive at once.
   */
  #queue = Promise.resolve();
  /** @type {Promise<void>} */
  #pendingWrite = Promise.resolve();
  /** Number of completed disk writes. Lets tests prove debouncing works. */
  #writeCount = 0;
  /** sha1 of the last text we wrote, used to recognise our own file events. */
  #lastWrittenHash = '';

  /** @type {import('node:fs').FSWatcher|null} */
  #watcher = null;
  /** @type {NodeJS.Timeout|null} */
  #reloadTimer = null;
  #closed = false;

  /**
   * @param {unknown} data - parsed db.json
   * @param {string} file - path the data came from
   * @param {StoreOptions} [options]
   */
  constructor(data, file, options = {}) {
    this.#data = normaliseDatabase(data);
    this.#file = file;
    this.#sync = options.sync ?? false;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#onError =
      options.onError ??
      ((error) => {
        // A persistence failure must never be invisible: the API has accepted a
        // change it may not be able to keep.
        process.stderr.write(`mocksmith: ${error.stack ?? error.message}\n`);
      });

    if (options.watch) this.#startWatching();
  }

  /**
   * Read and validate a database file.
   *
   * @param {string} file
   * @param {StoreOptions} [options]
   * @returns {Promise<Store>}
   */
  static async load(file, options = {}) {
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

    return new Store(parsed, file, options);
  }

  /** Path the database was loaded from. @returns {string} */
  get file() {
    return this.#file;
  }

  /** Completed disk writes since startup. @returns {number} */
  get writeCount() {
    return this.#writeCount;
  }

  /** True when memory holds changes that are not on disk yet. @returns {boolean} */
  get dirty() {
    return this.#dirty;
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
   * Subscribe to external-edit reloads, which replace the whole database and so
   * cannot be described as a per-resource change.
   *
   * @param {() => void} listener
   * @returns {() => void} unsubscribe
   */
  onReload(listener) {
    this.#reloadListeners.add(listener);
    return () => this.#reloadListeners.delete(listener);
  }

  /**
   * Resolves once it is safe to respond to a mutating request.
   *
   * With debounced persistence (the default) that is immediately: the in-memory
   * object is already authoritative and the response describes it truthfully.
   * Under `--sync` it waits for the write to reach disk, and rejects if that
   * write failed — so a 2xx never claims durability the disk did not give us.
   * Keeping the decision here means the router awaits the same call either way.
   *
   * @returns {Promise<void>}
   */
  async settled() {
    if (!this.#sync) return;
    await this.#pendingWrite;
  }

  /**
   * Write now, cancelling any pending debounce. Resolves when the bytes are on
   * disk.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    this.#cancelWriteTimer();
    await this.#enqueueWrite();
  }

  /**
   * Stop watching, flush anything outstanding, and drop listeners. Safe to call
   * more than once.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#watcher !== null) {
      this.#watcher.close();
      this.#watcher = null;
    }
    if (this.#reloadTimer !== null) {
      clearTimeout(this.#reloadTimer);
      this.#reloadTimer = null;
    }

    this.#cancelWriteTimer();
    await this.#enqueueWrite();

    this.#listeners.clear();
    this.#reloadListeners.clear();
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
    this.#touch();
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
    this.#touch();
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
    this.#touch();
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

    // One touch for the whole cascade: under --sync, deleting a post with a
    // hundred comments must cost one fsync, not a hundred.
    this.#touch();
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
    this.#touch();
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
    this.#touch();
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

  /** Record that memory has moved ahead of disk, and schedule the catch-up. */
  #touch() {
    this.#dirty = true;
    if (this.#closed) return;

    if (this.#sync) {
      const write = this.#enqueueWrite();
      this.#pendingWrite = write;
      // The request awaits this through settled() and reports the failure; the
      // no-op handler only stops Node warning about an unhandled rejection.
      write.catch(() => {});
      return;
    }

    if (this.#writeTimer !== null) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.#enqueueWrite().catch((error) => this.#onError(error));
    }, this.#debounceMs);
    // Never hold the process open for a pending write; close() flushes.
    this.#writeTimer.unref();
  }

  #cancelWriteTimer() {
    if (this.#writeTimer === null) return;
    clearTimeout(this.#writeTimer);
    this.#writeTimer = null;
  }

  /**
   * Chain a write onto the queue.
   *
   * The queue exists because two overlapping writes to one path can interleave
   * their renames and leave the older snapshot on disk. Serialising them means
   * the last write to start is the last to finish, so the file always ends up
   * holding the newest state.
   *
   * @returns {Promise<void>}
   */
  #enqueueWrite() {
    // settle() on both paths: a failed write must not stop the next one from
    // being attempted.
    const run = this.#queue.then(
      () => this.#writeSnapshot(),
      () => this.#writeSnapshot(),
    );
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * @returns {Promise<void>}
   */
  async #writeSnapshot() {
    if (!this.#dirty) return;

    // Snapshot and clear together: a mutation arriving mid-write sets the flag
    // again and gets its own write, rather than being lost inside this one.
    const text = serialiseDatabase(this.#data);
    this.#dirty = false;

    // Claim the hash *before* the rename lands: with --watch the directory
    // watcher can observe our own write before #atomicWrite resolves, and it
    // has to recognise those bytes as ours or it will reload in a loop.
    const previousHash = this.#lastWrittenHash;
    this.#lastWrittenHash = hashText(text);

    try {
      await this.#atomicWrite(text);
    } catch (error) {
      this.#dirty = true; // the change is still only in memory
      this.#lastWrittenHash = previousHash;
      throw error;
    }

    this.#writeCount += 1;
  }

  /**
   * Write the file atomically.
   *
   * Temp file in the *same directory* so the rename stays within one
   * filesystem, where POSIX guarantees it is atomic; a temp file in /tmp could
   * land on another device and degrade to a copy. fsync before the rename is
   * what makes the guarantee real: without it the rename can reach the disk
   * while the bytes it points at are still in the page cache.
   *
   * @param {string} text
   * @returns {Promise<void>}
   */
  async #atomicWrite(text) {
    const directory = dirname(this.#file);
    const temp = join(
      directory,
      `.${basename(this.#file)}.tmp.${process.pid}.${(tempFileCounter += 1)}`,
    );

    try {
      const handle = await open(temp, 'w');
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.#file);
    } catch (error) {
      // Never leave litter behind; the temp file is worthless once we failed.
      await unlink(temp).catch(() => {});
      throw new DatabaseError(`Could not write ${this.#file}: ${error.message}`);
    }

    await this.#syncDirectory(directory);
  }

  /**
   * fsync the directory so the rename itself survives a power cut, not just the
   * file contents it points at.
   *
   * Not every platform lets you open a directory for this; where it is refused
   * the file data is still fsync'd, so the worst case is the previous database
   * surviving instead of the new one — never a corrupt one.
   *
   * @param {string} directory
   * @returns {Promise<void>}
   */
  async #syncDirectory(directory) {
    let handle;
    try {
      handle = await open(directory, 'r');
    } catch (error) {
      if (['EACCES', 'EPERM', 'EISDIR', 'EINVAL'].includes(error.code)) return;
      throw new DatabaseError(`Could not open ${directory} to sync it: ${error.message}`);
    }

    try {
      await handle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) {
        throw new DatabaseError(`Could not sync ${directory}: ${error.message}`);
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Watch for external edits.
   *
   * The *directory* is watched, not the file: an atomic save replaces the file
   * by rename, and a file watcher would keep following the old inode and never
   * fire again after the first save.
   */
  #startWatching() {
    const directory = dirname(this.#file);
    const target = basename(this.#file);

    this.#watcher = watch(directory, (_eventType, filename) => {
      if (filename !== target) return;
      this.#scheduleReload();
    });
    this.#watcher.on('error', (error) => this.#onError(error));
    this.#watcher.unref();
  }

  #scheduleReload() {
    if (this.#reloadTimer !== null) return;
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = null;
      this.#reload().catch((error) => this.#onError(error));
    }, RELOAD_DEBOUNCE_MS);
    this.#reloadTimer.unref();
  }

  /**
   * Re-read the file after an external edit.
   *
   * Our own writes are recognised by hashing what we last wrote and comparing:
   * strictly better than comparing timestamps, which collide when two writes
   * land in the same millisecond, and which say nothing about content. A bad
   * edit is reported and ignored — the running server keeps the last good
   * database rather than dying because someone saved a half-typed brace.
   *
   * @returns {Promise<void>}
   */
  async #reload() {
    if (this.#closed) return;

    let text;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      this.#onError(new DatabaseError(`Could not re-read ${this.#file}: ${error.message}`));
      return;
    }

    if (hashText(text) === this.#lastWrittenHash) return; // our own write echoing back

    let next;
    try {
      next = normaliseDatabase(JSON.parse(text));
    } catch (error) {
      this.#onError(
        new DatabaseError(`Ignoring external edit to ${this.#file}: ${error.message}`),
      );
      return;
    }

    this.#data = next;
    // Adopt the on-disk content as our baseline so the same edit cannot loop.
    this.#lastWrittenHash = hashText(text);
    this.#dirty = false;

    for (const listener of this.#reloadListeners) {
      listener();
    }
  }
}
