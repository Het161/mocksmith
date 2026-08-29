/**
 * The version reported by `--version` and the startup banner.
 *
 * Deliberately a constant rather than a read of package.json: importing JSON at
 * runtime would break the single-file bundle, and reading it from disk would
 * depend on a path that does not exist once bundled. `test/version.test.js`
 * asserts this stays equal to the manifest, so the duplication cannot drift.
 */
export const VERSION = '0.1.0';
