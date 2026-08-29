/**
 * Shared test harness. Boots the real server on an ephemeral port against a
 * throwaway copy of a fixture database, so integration tests exercise the same
 * code path as `mocksmith db.json` with nothing mocked out.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/logger.js';
import { createServer } from '../../src/server.js';
import { Store } from '../../src/store.js';

/**
 * A small database covering both resource kinds and a parent/child pair.
 *
 * @returns {Record<string, unknown>}
 */
export function sampleDatabase() {
  return {
    posts: [
      { id: '1', title: 'first', author: 'het', views: 10 },
      { id: '2', title: 'second', author: 'het', views: 20 },
      { id: '3', title: 'third', author: 'raptor', views: 30 },
    ],
    comments: [
      { id: '10', postId: '1', body: 'on first' },
      { id: '11', postId: '1', body: 'also on first' },
      { id: '12', postId: '2', body: 'on second' },
    ],
    profile: { name: 'mocksmith', tagline: 'no dependencies' },
  };
}

/**
 * A logger that drops everything, including errors. Only for tests that provoke
 * a server-side failure on purpose and would otherwise print a stack trace that
 * looks like a real problem.
 *
 * @returns {import('../../src/logger.js').Logger}
 */
export function silentLogger() {
  return { paint: (_styles, text) => text, info() {}, warn() {}, error() {} };
}

/**
 * @typedef {object} TestServer
 * @property {string} url - origin the server is listening on
 * @property {string} file - path of the temporary database file
 * @property {string} dir - directory holding the database file
 * @property {import('../../src/store.js').Store} store
 * @property {import('node:http').Server} server
 */

/**
 * Start a server for the duration of one test. Cleanup is registered with
 * `t.after`, so a failing assertion still releases the port and the temp dir.
 *
 * @param {import('node:test').TestContext} t
 * @param {{data?: Record<string, unknown>, options?: object, storeOptions?: import('../../src/store.js').StoreOptions}} [setup]
 * @returns {Promise<TestServer>}
 */
export async function startTestServer(
  t,
  { data = sampleDatabase(), options = {}, storeOptions = {} } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'mocksmith-test-'));
  const file = join(dir, 'db.json');
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');

  const store = await Store.load(file, { onError: () => {}, ...storeOptions });
  // quiet suppresses the banner but still lets unexpected errors reach stderr.
  const server = createServer(store, { logger: createLogger({ quiet: true, color: false }), ...options });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      // fetch keeps connections alive; without this close() never settles.
      server.closeAllConnections();
    });
    // Tests that sabotage the disk on purpose leave a write that cannot
    // succeed; failing teardown over it would hide the assertion that matters.
    await store.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  return { url: `http://127.0.0.1:${port}`, file, dir, store, server };
}

/**
 * @typedef {object} ApiResponse
 * @property {number} status
 * @property {Headers} headers
 * @property {any} body - parsed JSON, or null for an empty response
 * @property {string} text
 */

/**
 * Perform a request and parse the response.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<ApiResponse>}
 */
export async function request(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text === '' ? null : JSON.parse(text),
  };
}

/**
 * Perform a request with a JSON body.
 *
 * @param {string} url
 * @param {string} method
 * @param {unknown} payload
 * @returns {Promise<ApiResponse>}
 */
export function sendJsonRequest(url, method, payload) {
  return request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
