/**
 * Durability under a crash, exercised through a real child process.
 *
 * SIGKILL cannot be caught, so nothing in our shutdown path runs: whatever is
 * on disk at that instant is all that survives. That makes this the only
 * honest test of the --sync guarantee.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const STARTUP_TIMEOUT_MS = 10_000;

/** @returns {Record<string, unknown>} */
function seed() {
  return { posts: [{ id: '1', title: 'first' }] };
}

/**
 * Start the CLI as a child process on an OS-assigned port.
 *
 * @param {string[]} args
 * @param {string} file
 * @returns {Promise<{child: import('node:child_process').ChildProcess, url: string}>}
 */
async function launch(args, file) {
  const child = spawn(process.execPath, [CLI, file, '--port', '0', '--no-color', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Server did not start in ${STARTUP_TIMEOUT_MS}ms. Output:\n${output}`)),
      STARTUP_TIMEOUT_MS,
    );

    const onData = (chunk) => {
      output += chunk;
      // --port 0 means the port is only known once the socket is bound, so the
      // banner is the authoritative source for it.
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match === null) return;
      clearTimeout(timer);
      resolve(`http://localhost:${match[1]}`);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with code ${code} before listening. Output:\n${output}`));
    });
  });

  return { child, url };
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 * @returns {Promise<void>}
 */
function stop(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill(signal);
  });
}

/**
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>} path to a throwaway database
 */
async function temporaryDatabase(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mocksmith-crash-'));
  const file = join(dir, 'db.json');
  await writeFile(file, JSON.stringify(seed(), null, 2), 'utf8');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return file;
}

describe('crash recovery', () => {
  it('keeps data written under --sync across a SIGKILL', async (t) => {
    const file = await temporaryDatabase(t);
    const { child, url } = await launch(['--sync'], file);
    t.after(() => stop(child, 'SIGKILL'));

    const created = await fetch(`${url}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'survives a crash' }),
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    // No graceful shutdown, no flush, no chance to clean up.
    await stop(child, 'SIGKILL');

    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk.posts.length, 2, 'the write reached disk before the response did');
    assert.equal(onDisk.posts[1].title, 'survives a crash');

    const restarted = await launch(['--sync'], file);
    t.after(() => stop(restarted.child, 'SIGKILL'));

    const fetched = await fetch(`${restarted.url}/posts/${id}`);
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json()).title, 'survives a crash');
  });

  it('leaves a valid database file after a SIGKILL, never a partial one', async (t) => {
    const file = await temporaryDatabase(t);
    const { child, url } = await launch(['--sync'], file);
    t.after(() => stop(child, 'SIGKILL'));

    // Kill in the middle of a burst: the atomic rename means the file is either
    // the old database or a new one, and parsing it proves which.
    const writes = Array.from({ length: 40 }, (_, i) =>
      fetch(`${url}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `burst ${i}`, filler: 'x'.repeat(2000) }),
      }).catch(() => undefined),
    );
    await Promise.race(writes);
    await stop(child, 'SIGKILL');
    await Promise.allSettled(writes);

    const text = await readFile(file, 'utf8');
    const onDisk = JSON.parse(text); // throws if a half-written file ever lands
    assert.ok(Array.isArray(onDisk.posts));
    assert.ok(onDisk.posts.length >= 2, 'at least the first burst write survived');
  });

  it('flushes debounced writes on a graceful SIGTERM', async (t) => {
    const file = await temporaryDatabase(t);
    const { child, url } = await launch([], file); // debounced, not --sync
    t.after(() => stop(child, 'SIGKILL'));

    await fetch(`${url}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'flushed on the way out' }),
    });

    await stop(child, 'SIGTERM');

    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk.posts.length, 2, 'shutdown flushed the pending write');
    assert.equal(onDisk.posts[1].title, 'flushed on the way out');
  });

  it('reports a database that cannot be parsed and exits non-zero', async (t) => {
    const file = await temporaryDatabase(t);
    await writeFile(file, '{ "posts": [ oops', 'utf8');

    const child = spawn(process.execPath, [CLI, file, '--port', '0', '--no-color'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => stop(child, 'SIGKILL'));

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });

    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(output, /is not valid JSON/);
  });
});
