# mocksmith — house rules

Zero Dependency 2026 (Hackathon Raptors), Track C. A reimplementation of
json-server v1 with live WebSocket updates and a built-in dashboard, written
against the Node standard library only.

## Non-negotiable constraints

Breaking any of these disqualifies the entry.

1. **Zero third-party runtime dependencies and zero devDependencies.**
   `package.json` carries `"dependencies": {}` and has no `devDependencies`
   key at all. Never run `npm install`.
2. **Node standard library only.** Every import specifier starts with `node:`
   or is relative (`./`, `../`). If a package would have helped, implement the
   slice we need and add a row to `STDLIB.md`.
3. **Target Node 24 LTS.** `"engines": {"node": ">=22"}`, `"type": "module"`.
4. **Never read, fetch, or reproduce json-server's source.** We implement from
   its documented behavior only. Copying source breaks the event rules.
5. **All code is written during the event**, committed small and often with
   conventional commit messages, so the git history is the proof.
6. **Runs on Linux and macOS.**

## Import discipline (required by the bundler)

`scripts/build.js` produces a deterministic single-file `dist/mocksmith.mjs` by
concatenating our sources in a fixed order. That is only possible if every file
obeys these rules from the first commit — they cannot be retrofitted:

- ESM only.
- **Static named imports and named exports.** No default exports.
- No dynamic `import()`, no `require`, no top-level side effects outside
  `src/cli.js`.
- No circular imports. The dependency graph flows one way:

```
cli.js -> server.js -> router.js -> store.js, query.js, http-utils.js
                    -> static.js, logger.js, ws/server.js -> ws/frames.js
```

`http-utils.js`, `logger.js`, `version.js` and `ws/frames.js` import nothing of
ours.

## Ownership

- **Ours:** everything except the two files below.
- **Teammate's:** `src/query.js` and `test/query.test.js`. Until that branch
  merges, `src/query.js` is a clearly marked stub. Nothing may couple to it
  beyond the six exported signatures documented in its header. When the branch
  lands, the stub is replaced wholesale and never edited afterwards.

## Style

- Small pure functions where possible. Classes only for `Store` and
  `WSConnection`.
- JSDoc on every export.
- Explicit error handling. No silent `catch`.
- `process.exit` appears only in `src/cli.js`.
- Comments explain **why**, not what.
- Ids are always strings, coerced once at the boundary.

## Testing

`node --test` must stay green. `node:test` + `node:assert/strict` only.
Any change touching `src/store.js` or `src/ws/*` requires a full-suite run.

## Ambiguity policy

Follow json-server v1's documented behavior. Where it is undocumented, take the
simplest RESTful choice and record it under "Compatibility notes" in
`README.md`. Never expand scope; never add a dependency.
