/**
 * The error model, end to end. Every failure the client can provoke has to come
 * back as JSON with the right status — never an HTML page, never a hang, never
 * a 2xx that overstates what happened.
 */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { rm } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { request, sendJsonRequest, silentLogger, startTestServer } from '../helpers/harness.js';

/**
 * Send a request with node:http rather than fetch, for the cases fetch refuses
 * to construct — exotic methods and deliberately broken paths.
 *
 * @param {string} origin
 * @param {string} method
 * @param {string} path
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, body: any}>}
 */
function rawRequest(origin, method, path) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, method, path }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: text === '' ? null : JSON.parse(text),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('error responses', () => {
  it('are JSON with an error.message on every status', async (t) => {
    const { url } = await startTestServer(t);

    const cases = [
      [404, await request(`${url}/posts/nope`)],
      [404, await request(`${url}/widgets`)],
      [405, await request(`${url}/posts`, { method: 'DELETE' })],
      [409, await sendJsonRequest(`${url}/posts`, 'POST', { id: '1' })],
      [400, await sendJsonRequest(`${url}/posts`, 'POST', 'not an object')],
    ];

    for (const [status, response] of cases) {
      assert.equal(response.status, status);
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(typeof response.body.error.message, 'string');
      assert.ok(response.body.error.message.length > 0);
    }
  });

  it('405s a method the route does not implement, whatever it is', async (t) => {
    const { url } = await startTestServer(t);
    const response = await rawRequest(url, 'PURGE', '/posts');
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD, POST, OPTIONS');
  });

  it('400s a path with broken percent-encoding rather than crashing', async (t) => {
    const { url } = await startTestServer(t);
    const response = await rawRequest(url, 'GET', '/posts/%ZZ');
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /percent-encoding/);
  });

  it('survives a request for a deeply nested path', async (t) => {
    const { url } = await startTestServer(t);
    assert.equal((await request(`${url}/a/b/c/d/e/f`)).status, 404);
  });
});

describe('durability failures', () => {
  it('500s under --sync when the write cannot reach disk', async (t) => {
    const { url, dir } = await startTestServer(t, {
      storeOptions: { sync: true },
      options: { logger: silentLogger() },
    });

    // The database's directory disappears out from under the server — a full
    // or read-only disk looks the same from here.
    await rm(dir, { recursive: true, force: true });

    const response = await sendJsonRequest(`${url}/posts`, 'POST', { title: 'cannot persist' });

    // --sync promises the response only comes after the bytes are safe. When
    // they are not, the only honest answer is a failure, not a 201.
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: { message: 'Internal server error' } });
  });

  it('still answers reads while writes are failing', async (t) => {
    const { url, dir } = await startTestServer(t, {
      storeOptions: { sync: true },
      options: { logger: silentLogger() },
    });
    await rm(dir, { recursive: true, force: true });

    await sendJsonRequest(`${url}/posts`, 'POST', { title: 'cannot persist' });
    const response = await request(`${url}/posts`);
    assert.equal(response.status, 200);
  });
});
