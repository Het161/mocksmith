import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { request, sendJsonRequest, startTestServer } from '../helpers/harness.js';

describe('resource index', () => {
  it('maps every resource to its path', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      posts: '/posts',
      comments: '/comments',
      profile: '/profile',
    });
  });
});

describe('reading collections', () => {
  it('returns a plain array when no page is requested', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.ok(Array.isArray(response.body));
    assert.equal(response.body.length, 3);
  });

  it('ignores a trailing slash', async (t) => {
    const { url } = await startTestServer(t);
    assert.equal((await request(`${url}/posts/`)).status, 200);
  });

  it('filters on an equality condition', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts?author=het`);
    assert.deepEqual(
      response.body.map((post) => post.id),
      ['1', '2'],
    );
  });

  it('returns the pagination envelope when _page is present', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts?_page=2&_per_page=2`);
    assert.equal(response.body.items, 3, 'items counts every match, not the page');
    assert.equal(response.body.pages, 2);
    assert.equal(response.body.first, 1);
    assert.equal(response.body.prev, 1);
    assert.equal(response.body.next, null);
    assert.equal(response.body.last, 2);
    assert.deepEqual(
      response.body.data.map((post) => post.id),
      ['3'],
    );
  });
});

describe('reading items', () => {
  it('returns an item by id', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts/2`);
    assert.equal(response.status, 200);
    assert.equal(response.body.title, 'second');
  });

  it('404s an unknown id with a JSON error body', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts/nope`);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: { message: 'No posts with id "nope"' } });
  });

  it('404s an unknown resource', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/widgets`);
    assert.equal(response.status, 404);
    assert.match(response.body.error.message, /No resource named "widgets"/);
  });

  it('404s a path with too many segments', async (t) => {
    const { url } = await startTestServer(t);
    assert.equal((await request(`${url}/posts/1/comments`)).status, 404);
  });
});

describe('creating', () => {
  it('returns 201, the created object and a Location header', async (t) => {
    const { url } = await startTestServer(t);
    const response = await sendJsonRequest(`${url}/posts`, 'POST', { title: 'new', author: 'het' });

    assert.equal(response.status, 201);
    assert.equal(typeof response.body.id, 'string');
    assert.match(response.body.id, /^[0-9a-z]{6}$/);
    assert.equal(response.headers.get('location'), `/posts/${response.body.id}`);

    const fetched = await request(`${url}/posts/${response.body.id}`);
    assert.equal(fetched.body.title, 'new');
  });

  it('keeps a client-supplied id, as a string', async (t) => {
    const { url } = await startTestServer(t);
    const response = await sendJsonRequest(`${url}/posts`, 'POST', { id: 42, title: 'forty two' });
    assert.equal(response.body.id, '42');
    assert.equal((await request(`${url}/posts/42`)).status, 200);
  });

  it('409s when the supplied id already exists', async (t) => {
    const { url } = await startTestServer(t);
    const response = await sendJsonRequest(`${url}/posts`, 'POST', { id: '1', title: 'clash' });
    assert.equal(response.status, 409);
    assert.match(response.body.error.message, /already exists/);
  });
});

describe('updating', () => {
  it('PUT replaces the whole object but keeps the id', async (t) => {
    const { url } = await startTestServer(t);
    const response = await sendJsonRequest(`${url}/posts/1`, 'PUT', { title: 'replaced' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { id: '1', title: 'replaced' });
  });

  it('PUT cannot re-key a record through the body', async (t) => {
    const { url } = await startTestServer(t);
    await sendJsonRequest(`${url}/posts/1`, 'PUT', { id: 'hijack', title: 'x' });
    assert.equal((await request(`${url}/posts/hijack`)).status, 404);
    assert.equal((await request(`${url}/posts/1`)).status, 200);
  });

  it('PATCH merges shallowly', async (t) => {
    const { url } = await startTestServer(t);
    const response = await sendJsonRequest(`${url}/posts/1`, 'PATCH', { views: 99 });
    assert.deepEqual(response.body, { id: '1', title: 'first', author: 'het', views: 99 });
  });

  it('404s PUT and PATCH on a missing item', async (t) => {
    const { url } = await startTestServer(t);
    assert.equal((await sendJsonRequest(`${url}/posts/nope`, 'PUT', { a: 1 })).status, 404);
    assert.equal((await sendJsonRequest(`${url}/posts/nope`, 'PATCH', { a: 1 })).status, 404);
  });
});

describe('deleting', () => {
  it('responds with the deleted object and then 404s it', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts/1`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal(response.body.title, 'first');
    assert.equal((await request(`${url}/posts/1`)).status, 404);
  });

  it('leaves children alone without _dependent', async (t) => {
    const { url } = await startTestServer(t);
    await request(`${url}/posts/1`, { method: 'DELETE' });
    assert.equal((await request(`${url}/comments`)).body.length, 3);
  });

  it('cascades to children with _dependent', async (t) => {
    const { url } = await startTestServer(t);
    await request(`${url}/posts/1?_dependent=comments`, { method: 'DELETE' });
    assert.deepEqual(
      (await request(`${url}/comments`)).body.map((comment) => comment.id),
      ['12'],
    );
  });

  it('400s an unknown dependent collection rather than silently ignoring it', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts/1?_dependent=widgets`, { method: 'DELETE' });
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /Unknown dependent collection "widgets"/);
    assert.equal((await request(`${url}/posts/1`)).status, 200, 'the delete did not happen');
  });
});

describe('singular resources', () => {
  it('supports GET, PUT and PATCH', async (t) => {
    const { url } = await startTestServer(t);
    assert.deepEqual((await request(`${url}/profile`)).body, {
      name: 'mocksmith',
      tagline: 'no dependencies',
    });

    const patched = await sendJsonRequest(`${url}/profile`, 'PATCH', { tagline: 'still none' });
    assert.deepEqual(patched.body, { name: 'mocksmith', tagline: 'still none' });

    const replaced = await sendJsonRequest(`${url}/profile`, 'PUT', { name: 'only' });
    assert.deepEqual(replaced.body, { name: 'only' });
  });

  it('405s DELETE with an Allow header', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/profile`, { method: 'DELETE' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD, PUT, PATCH, OPTIONS');
  });

  it('404s a member path, because it has no members', async (t) => {
    const { url } = await startTestServer(t);
    assert.equal((await request(`${url}/profile/1`)).status, 404);
  });
});

describe('method handling', () => {
  it('405s POST on an item path and advertises what is allowed', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts/1`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD, PUT, PATCH, DELETE, OPTIONS');
  });

  it('405s DELETE on a collection path', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts`, { method: 'DELETE' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD, POST, OPTIONS');
  });

  it('answers HEAD with headers but no body', async (t) => {
    const { url } = await startTestServer(t);
    const response = await fetch(`${url}/posts`, { method: 'HEAD' });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(body, '');
    assert.ok(Number(response.headers.get('content-length')) > 0, 'length of the GET body');
  });
});

describe('request bodies', () => {
  it('400s malformed JSON', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /not valid JSON/);
  });

  it('400s an empty body', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /empty/);
  });

  it('400s a body that is not an object', async (t) => {
    const { url } = await startTestServer(t);
    const response = await sendJsonRequest(`${url}/posts`, 'POST', [1, 2, 3]);
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /must be a JSON object/);
  });

  it('415s a non-JSON content type', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"title":"x"}',
    });
    assert.equal(response.status, 415);
  });

  it('accepts a charset parameter on the content type', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: '{"title":"x"}',
    });
    assert.equal(response.status, 201);
  });

  it('413s a body over the 1MB limit', async (t) => {
    const { url } = await startTestServer(t);
    const response = await request(`${url}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(1024 * 1024 + 1) }),
    });
    assert.equal(response.status, 413);
    assert.match(response.body.error.message, /exceeds the 1048576 byte limit/);
  });
});

describe('CORS', () => {
  it('answers preflight with 204 and the policy', async (t) => {
    const { url } = await startTestServer(t);
    const response = await fetch(`${url}/posts`, { method: 'OPTIONS' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-methods'), /PATCH/);
  });

  it('answers preflight for a path that does not exist', async (t) => {
    const { url } = await startTestServer(t);
    assert.equal((await fetch(`${url}/widgets`, { method: 'OPTIONS' })).status, 204);
  });

  it('sets the origin header on ordinary responses, including errors', async (t) => {
    const { url } = await startTestServer(t);
    assert.equal((await request(`${url}/posts`)).headers.get('access-control-allow-origin'), '*');
    assert.equal((await request(`${url}/nope`)).headers.get('access-control-allow-origin'), '*');
  });
});

describe('ids in paths', () => {
  it('round-trips an id that needs percent-encoding', async (t) => {
    const { url } = await startTestServer(t);
    const created = await sendJsonRequest(`${url}/posts`, 'POST', { id: 'a b/c', title: 'odd' });

    assert.equal(created.body.id, 'a b/c');
    assert.equal(created.headers.get('location'), '/posts/a%20b%2Fc');
    assert.equal((await request(`${url}/posts/a%20b%2Fc`)).body.title, 'odd');
  });
});
