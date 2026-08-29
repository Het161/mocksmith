import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coerceId,
  DatabaseError,
  generateId,
  isPlainObject,
  normaliseDatabase,
  singularize,
  Store,
} from '../src/store.js';

/** @returns {Record<string, unknown>} */
function database() {
  return {
    posts: [
      { id: '1', title: 'first' },
      { id: '2', title: 'second' },
    ],
    comments: [
      { id: '10', postId: '1', body: 'a' },
      { id: '11', postId: '1', body: 'b' },
      { id: '12', postId: '2', body: 'c' },
    ],
    profile: { name: 'mocksmith' },
  };
}

describe('generateId', () => {
  it('produces six base36 characters', () => {
    for (let i = 0; i < 50; i += 1) {
      assert.match(generateId(), /^[0-9a-z]{6}$/);
    }
  });

  it('honours a requested length', () => {
    assert.equal(generateId(4).length, 4);
  });

  it('does not repeat itself over many draws', () => {
    const ids = new Set();
    for (let i = 0; i < 5000; i += 1) ids.add(generateId());
    assert.equal(ids.size, 5000);
  });
});

describe('singularize', () => {
  it('strips a trailing s', () => {
    assert.equal(singularize('comments'), 'comment');
    assert.equal(singularize('posts'), 'post');
  });

  it('leaves names that do not end in s alone', () => {
    assert.equal(singularize('profile'), 'profile');
    assert.equal(singularize('s'), 's');
  });
});

describe('isPlainObject', () => {
  it('separates objects from arrays and primitives', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject(7), false);
  });
});

describe('coerceId', () => {
  it('turns numbers into strings and passes strings through', () => {
    assert.equal(coerceId(7, 'x'), '7');
    assert.equal(coerceId('7', 'x'), '7');
  });

  it('rejects anything else', () => {
    assert.throws(() => coerceId(true, 'somewhere'), {
      name: 'DatabaseError',
      message: /somewhere: id must be a string or a number, got boolean/,
    });
  });
});

describe('normaliseDatabase', () => {
  it('rejects a non-object root', () => {
    assert.throws(() => normaliseDatabase([]), { message: /root must be a JSON object.*an array/ });
    assert.throws(() => normaliseDatabase(42), { message: /root must be a JSON object.*number/ });
  });

  it('rejects a resource that is neither an array nor an object', () => {
    assert.throws(() => normaliseDatabase({ posts: 'nope' }), {
      message: /Resource "posts" must be an array \(collection\) or an object \(singular\), got string/,
    });
  });

  it('rejects a collection holding primitives', () => {
    assert.throws(() => normaliseDatabase({ posts: [{ id: '1' }, 'nope'] }), {
      message: /Collection "posts" item at index 1 must be an object/,
    });
  });

  it('rejects duplicate ids so a broken fixture never boots', () => {
    assert.throws(() => normaliseDatabase({ posts: [{ id: 1 }, { id: '1' }] }), {
      name: 'DatabaseError',
      message: /Collection "posts" has duplicate id "1"/,
    });
  });

  it('coerces numeric ids to strings', () => {
    const data = normaliseDatabase({ posts: [{ id: 1 }, { id: 2 }] });
    assert.deepEqual(
      data.posts.map((post) => post.id),
      ['1', '2'],
    );
  });

  it('generates ids for items that lack one', () => {
    const data = normaliseDatabase({ posts: [{ title: 'a' }, { title: 'b' }] });
    const [first, second] = data.posts;
    assert.match(first.id, /^[0-9a-z]{6}$/);
    assert.notEqual(first.id, second.id);
  });

  it('leaves singular resources untouched', () => {
    const data = normaliseDatabase({ profile: { name: 'x' } });
    assert.deepEqual(data.profile, { name: 'x' });
  });
});

describe('Store lookups', () => {
  it('reports resource kinds', () => {
    const store = new Store(database(), 'db.json');
    assert.deepEqual(store.resources(), [
      { name: 'posts', type: 'collection', count: 2 },
      { name: 'comments', type: 'collection', count: 3 },
      { name: 'profile', type: 'singular', count: 1 },
    ]);
    assert.equal(store.isCollection('posts'), true);
    assert.equal(store.isSingular('profile'), true);
    assert.equal(store.isCollection('profile'), false);
  });

  it('does not resolve inherited properties as resources', () => {
    const store = new Store(database(), 'db.json');
    assert.equal(store.has('__proto__'), false);
    assert.equal(store.has('toString'), false);
    assert.equal(store.has('constructor'), false);
  });

  it('returns null for a missing item rather than throwing', () => {
    const store = new Store(database(), 'db.json');
    assert.equal(store.get('posts', 'nope'), null);
  });
});

describe('Store mutations', () => {
  it('creates with a generated string id', () => {
    const store = new Store(database(), 'db.json');
    const created = store.create('posts', { title: 'third' });
    assert.equal(typeof created.id, 'string');
    assert.equal(store.get('posts', created.id).title, 'third');
    assert.equal(store.list('posts').length, 3);
  });

  it('creates with a caller-supplied id, coerced to a string', () => {
    const store = new Store(database(), 'db.json');
    const created = store.create('posts', { id: 99, title: 'third' });
    assert.equal(created.id, '99');
  });

  it('replaces without letting the body change the id', () => {
    const store = new Store(database(), 'db.json');
    const replaced = store.replace('posts', '1', { id: 'hijack', body: 'new' });
    assert.deepEqual(replaced, { id: '1', body: 'new' });
    assert.equal(store.get('posts', 'hijack'), null);
  });

  it('merges shallowly', () => {
    const store = new Store(database(), 'db.json');
    const merged = store.merge('posts', '1', { title: 'renamed', extra: true });
    assert.deepEqual(merged, { id: '1', title: 'renamed', extra: true });
  });

  it('reports a miss on replace, merge and remove', () => {
    const store = new Store(database(), 'db.json');
    assert.equal(store.replace('posts', 'nope', {}), null);
    assert.equal(store.merge('posts', 'nope', {}), null);
    assert.equal(store.remove('posts', 'nope'), null);
  });

  it('removes an item and returns it', () => {
    const store = new Store(database(), 'db.json');
    const removed = store.remove('posts', '1');
    assert.equal(removed.title, 'first');
    assert.equal(store.get('posts', '1'), null);
    assert.equal(store.list('comments').length, 3, 'children survive without _dependent');
  });

  it('cascades to dependent collections by <singular>Id', () => {
    const store = new Store(database(), 'db.json');
    store.remove('posts', '1', { dependents: ['comments'] });
    assert.deepEqual(
      store.list('comments').map((comment) => comment.id),
      ['12'],
    );
  });

  it('matches dependents whose foreign key is numeric', () => {
    const store = new Store(
      { posts: [{ id: '1' }], comments: [{ id: '10', postId: 1 }] },
      'db.json',
    );
    store.remove('posts', '1', { dependents: ['comments'] });
    assert.equal(store.list('comments').length, 0);
  });

  it('replaces and merges singular resources', () => {
    const store = new Store(database(), 'db.json');
    assert.deepEqual(store.replaceSingular('profile', { name: 'other' }), { name: 'other' });
    assert.deepEqual(store.mergeSingular('profile', { extra: 1 }), { name: 'other', extra: 1 });
  });

  it('refuses to treat a singular resource as a collection', () => {
    const store = new Store(database(), 'db.json');
    assert.throws(() => store.list('profile'), DatabaseError);
  });
});

describe('Store change events', () => {
  it('emits one event per mutation, including cascaded deletes', () => {
    const store = new Store(database(), 'db.json');
    const events = [];
    store.onChange((event) => events.push(event));

    const created = store.create('posts', { title: 'third' });
    store.merge('posts', created.id, { title: 'renamed' });
    store.remove('posts', '1', { dependents: ['comments'] });

    assert.deepEqual(
      events.map((event) => [event.resource, event.action, event.id]),
      [
        ['posts', 'create', created.id],
        ['posts', 'update', created.id],
        ['posts', 'delete', '1'],
        ['comments', 'delete', '11'],
        ['comments', 'delete', '10'],
      ],
    );
  });

  it('stops delivering after unsubscribe', () => {
    const store = new Store(database(), 'db.json');
    let count = 0;
    const unsubscribe = store.onChange(() => {
      count += 1;
    });
    store.create('posts', {});
    unsubscribe();
    store.create('posts', {});
    assert.equal(count, 1);
  });

  it('carries a null id for singular resources, which have none', () => {
    const store = new Store(database(), 'db.json');
    const events = [];
    store.onChange((event) => events.push(event));
    store.mergeSingular('profile', { name: 'x' });
    assert.equal(events[0].id, null);
    assert.equal(events[0].resource, 'profile');
  });
});

describe('Store.load', () => {
  it('explains a missing file instead of leaking an fs error', async () => {
    await assert.rejects(() => Store.load('/definitely/not/here.json'), {
      name: 'DatabaseError',
      message: /Cannot read database file/,
    });
  });
});
