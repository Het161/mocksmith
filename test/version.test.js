import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { VERSION } from '../src/version.js';

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));

describe('package manifest', () => {
  it('agrees with the version constant', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(
      manifest.version,
      VERSION,
      'src/version.js duplicates package.json so the bundle needs no JSON import; keep them equal',
    );
  });

  it('declares no dependencies of any kind', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(manifest.dependencies, {}, 'the entry must stay dependency-free');
    assert.equal(
      Object.hasOwn(manifest, 'devDependencies'),
      false,
      'a devDependencies key at all would disqualify the entry',
    );
  });
});
