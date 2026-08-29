import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';

/** @returns {Record<string, unknown>} */
function seed() {
  return { posts: [{ id: '1', title: 'first' }], profile: { name: 'mocksmith' } };
}

/**
 * Create a store backed by a throwaway file.
 *
 * @param {import('node:test').TestContext} t
 * @param {import('../src/store.js').StoreOptions & {data?: Record<string, unknown>}} [options]
 * @returns {Promise<{store: Store, file: string, dir: string, errors: Error[]}>}
 */
async function makeStore(t, { data = seed(), ...options } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mocksmith-persist-'));
  const file = join(dir, 'db.json');
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');

  /** @type {Error[]} */
  const errors = [];
  const store = await Store.load(file, {
    debounceMs: 20,
    onError: (error) => errors.push(error),
    ...options,
  });

  t.after(async () => {
    await store.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  return { store, file, dir, errors };
}

/**
 * @param {string} file
 * @returns {Promise<Record<string, any>>}
 */
async function readDatabase(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * Poll until a condition holds, so tests wait for the shortest time that works
 * rather than a fixed sleep.
 *
 * @param {() => boolean|Promise<boolean>} predicate
 * @param {{timeoutMs?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, { timeoutMs = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

describe('debounced writes', () => {
  it('does not touch the disk before the debounce elapses', async (t) => {
    const { store, file } = await makeStore(t);
    store.create('posts', { title: 'second' });

    assert.equal(store.dirty, true);
    assert.equal(store.writeCount, 0);
    assert.equal((await readDatabase(file)).posts.length, 1, 'disk still holds the old state');
  });

  it('coalesces a burst of mutations into a single write', async (t) => {
    const { store, file } = await makeStore(t);
    for (let i = 0; i < 20; i += 1) store.create('posts', { title: `post ${i}` });

    await waitFor(() => store.writeCount > 0, { label: 'the debounced write' });
    await delay(60);

    assert.equal(store.writeCount, 1, '20 mutations, one fsync');
    assert.equal((await readDatabase(file)).posts.length, 21);
    assert.equal(store.dirty, false);
  });

  it('starts a fresh debounce window after each write', async (t) => {
    const { store } = await makeStore(t);
    store.create('posts', {});
    await waitFor(() => store.writeCount === 1);
    store.create('posts', {});
    await waitFor(() => store.writeCount === 2);
  });

  it('flush() writes immediately and cancels the pending timer', async (t) => {
    const { store, file } = await makeStore(t);
    store.merge('posts', '1', { title: 'flushed' });
    await store.flush();

    assert.equal(store.writeCount, 1);
    assert.equal((await readDatabase(file)).posts[0].title, 'flushed');

    await delay(60);
    assert.equal(store.writeCount, 1, 'the cancelled timer did not fire a second write');
  });

  it('close() flushes work that is still pending', async (t) => {
    const { store, file } = await makeStore(t);
    store.create('posts', { title: 'must survive' });
    await store.close();

    const data = await readDatabase(file);
    assert.equal(data.posts.length, 2);
    assert.equal(data.posts[1].title, 'must survive');
  });
});

describe('--sync writes', () => {
  it('has the data on disk by the time settled() resolves', async (t) => {
    const { store, file } = await makeStore(t, { sync: true });

    store.create('posts', { title: 'durable' });
    await store.settled();

    assert.equal(store.dirty, false);
    assert.equal((await readDatabase(file)).posts.length, 2);
  });

  it('merges mutations that arrive before the write starts, and persists both', async (t) => {
    const { store, file } = await makeStore(t, { sync: true });
    store.create('posts', { title: 'a' });
    store.create('posts', { title: 'b' });
    await store.settled();

    // The queue is what earns this: the second mutation lands while the first
    // write is still only scheduled, so one snapshot covers both. --sync
    // promises durability by the time settled() resolves, not one fsync per
    // call, and this is the cheaper way to keep that promise.
    assert.equal(store.writeCount, 1);
    assert.deepEqual(
      (await readDatabase(file)).posts.map((post) => post.title),
      ['first', 'a', 'b'],
    );
    assert.equal(store.dirty, false);
  });

  it('writes again for a mutation that arrives after the previous write', async (t) => {
    const { store } = await makeStore(t, { sync: true });
    store.create('posts', { title: 'a' });
    await store.settled();
    store.create('posts', { title: 'b' });
    await store.settled();
    assert.equal(store.writeCount, 2);
  });

  it('costs one write for a whole cascading delete', async (t) => {
    const { store } = await makeStore(t, {
      sync: true,
      data: {
        posts: [{ id: '1' }],
        comments: Array.from({ length: 10 }, (_, i) => ({ id: String(i), postId: '1' })),
      },
    });

    store.remove('posts', '1', { dependents: ['comments'] });
    await store.settled();

    assert.equal(store.writeCount, 1, 'ten cascaded deletes, one fsync');
  });

  it('resolves immediately in debounced mode, without waiting for disk', async (t) => {
    const { store } = await makeStore(t);
    store.create('posts', {});
    await store.settled();
    assert.equal(store.writeCount, 0, 'the response does not wait for the write');
  });
});

describe('the write queue', () => {
  it('serialises overlapping writes and ends on the newest state', async (t) => {
    const { store, file } = await makeStore(t);

    const flushes = [];
    for (let i = 0; i < 25; i += 1) {
      store.merge('posts', '1', { title: `revision ${i}` });
      flushes.push(store.flush());
    }
    await Promise.all(flushes);

    assert.equal((await readDatabase(file)).posts[0].title, 'revision 24');
    assert.equal(store.dirty, false);
  });

  it('keeps the file parseable at every instant during a write storm', async (t) => {
    const { store, file } = await makeStore(t, {
      data: { posts: Array.from({ length: 400 }, (_, i) => ({ id: String(i), body: 'x'.repeat(200) })) },
    });

    let reads = 0;
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        // The rename is atomic, so a reader sees the whole old file or the
        // whole new one. A non-atomic write would surface here as a parse error.
        const text = await readFile(file, 'utf8');
        JSON.parse(text);
        reads += 1;
      }
    })();

    for (let i = 0; i < 30; i += 1) {
      store.merge('posts', '1', { body: `revision ${i}` });
      await store.flush();
    }

    stop = true;
    await reader;
    assert.ok(reads > 0, 'the reader actually ran');
    assert.equal((await readDatabase(file)).posts[1].body, 'revision 29');
  });

  it('leaves no temp files behind', async (t) => {
    const { store, dir } = await makeStore(t);
    for (let i = 0; i < 5; i += 1) {
      store.create('posts', { i });
      await store.flush();
    }
    assert.deepEqual(await readdir(dir), ['db.json']);
  });
});

describe('write failures', () => {
  /**
   * @param {import('node:test').TestContext} t
   * @returns {Promise<{store: Store, errors: Error[], dir: string}>}
   */
  async function storeOverAVanishedDirectory(t) {
    const { store, errors, dir } = await makeStore(t);
    // Removing the directory makes every subsequent write fail for a reason the
    // store cannot control — the same shape as a full or read-only disk.
    await rm(dir, { recursive: true, force: true });
    return { store, errors, dir };
  }

  it('reports a failed background write instead of swallowing it', async (t) => {
    const { store, errors } = await storeOverAVanishedDirectory(t);
    store.create('posts', { title: 'doomed' });

    await waitFor(() => errors.length > 0, { label: 'the write error' });
    assert.match(errors[0].message, /Could not write/);
    assert.equal(store.dirty, true, 'the change is still pending, not silently dropped');
  });

  it('rejects settled() under --sync so the request cannot report a false 2xx', async (t) => {
    const { store, dir } = await makeStore(t, { sync: true });
    await rm(dir, { recursive: true, force: true });

    store.create('posts', { title: 'doomed' });
    await assert.rejects(() => store.settled(), { name: 'DatabaseError', message: /Could not write/ });
  });

  it('keeps accepting writes after a failure clears', async (t) => {
    const { store, errors, dir } = await storeOverAVanishedDirectory(t);
    store.create('posts', { title: 'doomed' });
    await waitFor(() => errors.length > 0);

    await mkdir(dir, { recursive: true });

    store.create('posts', { title: 'recovered' });
    await store.flush();

    const data = await readDatabase(store.file);
    assert.equal(data.posts.length, 3, 'the queue survived the failure');
  });
});

describe('--watch', () => {
  it('reloads after an external edit and announces it', async (t) => {
    const { store, file } = await makeStore(t, { watch: true });

    let reloads = 0;
    store.onReload(() => {
      reloads += 1;
    });

    await writeFile(
      file,
      JSON.stringify({ posts: [{ id: '9', title: 'edited by hand' }] }, null, 2),
      'utf8',
    );

    await waitFor(() => reloads > 0, { label: 'the reload' });
    assert.equal(store.get('posts', '9').title, 'edited by hand');
    assert.equal(store.get('posts', '1'), null, 'the old state is gone');
  });

  it('does not reload in response to its own writes', async (t) => {
    const { store, errors } = await makeStore(t, { watch: true });

    let reloads = 0;
    store.onReload(() => {
      reloads += 1;
    });

    for (let i = 0; i < 5; i += 1) {
      store.create('posts', { title: `own write ${i}` });
      await store.flush();
    }
    await delay(200);

    assert.equal(reloads, 0, 'a feedback loop would have fired here');
    assert.deepEqual(errors, []);
    assert.equal(store.list('posts').length, 6, 'and memory is intact');
  });

  it('ignores an unparseable edit and keeps serving the last good database', async (t) => {
    const { store, file, errors } = await makeStore(t, { watch: true });

    let reloads = 0;
    store.onReload(() => {
      reloads += 1;
    });

    await writeFile(file, '{ "posts": [ half a thought', 'utf8');
    await waitFor(() => errors.length > 0, { label: 'the parse error' });

    assert.match(errors[0].message, /Ignoring external edit/);
    assert.equal(reloads, 0);
    assert.equal(store.get('posts', '1').title, 'first', 'still serving the good data');
  });

  it('ignores an edit that fails validation', async (t) => {
    const { store, file, errors } = await makeStore(t, { watch: true });

    await writeFile(file, JSON.stringify({ posts: [{ id: '1' }, { id: '1' }] }), 'utf8');
    await waitFor(() => errors.length > 0, { label: 'the validation error' });

    assert.match(errors[0].message, /duplicate id/);
    assert.equal(store.list('posts').length, 1);
  });

  it('keeps watching across an atomic replacement of the file', async (t) => {
    const { store, file } = await makeStore(t, { watch: true });

    // Our own atomic write replaces the inode; a naive file watcher would stop
    // reporting anything after this point.
    store.create('posts', { title: 'ours' });
    await store.flush();

    let reloads = 0;
    store.onReload(() => {
      reloads += 1;
    });

    await writeFile(file, JSON.stringify({ posts: [{ id: '77' }] }), 'utf8');
    await waitFor(() => reloads > 0, { label: 'a reload after the inode changed' });
    assert.equal(store.get('posts', '77').id, '77');
  });
});
