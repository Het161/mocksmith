#!/usr/bin/env node
/**
 * Command line entry point. The only module allowed to call `process.exit` or
 * to install signal handlers — everything below it stays importable and
 * testable without side effects.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createLogger, shouldUseColor } from './logger.js';
import { createServer } from './server.js';
import { DatabaseError, Store } from './store.js';
import { VERSION } from './version.js';

const DEFAULT_DB = 'db.json';
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = 'localhost';
const DEFAULT_STATIC_DIR = 'public';

/** How long a graceful shutdown waits for in-flight requests before forcing. */
const SHUTDOWN_GRACE_MS = 2000;

const USAGE = `mocksmith ${VERSION} — a zero-dependency mock REST API

Usage
  mocksmith [db.json] [options]

Options
  -p, --port <number>   Port to listen on (default: ${DEFAULT_PORT})
      --host <host>     Host to bind (default: ${DEFAULT_HOST})
  -s, --static <dir>    Serve a directory of static files; repeatable.
                        Defaults to ./${DEFAULT_STATIC_DIR} when it exists
  -w, --watch           Reload when the database file is edited externally
      --sync            Wait for each write to reach disk before responding
  -q, --quiet           Suppress informational output
      --no-color        Disable coloured output
  -h, --help            Show this help
  -v, --version         Show the version

Examples
  mocksmith db.json --port 4000
  mocksmith fixtures/api.json --watch --static ./public`;

/**
 * @typedef {object} CliOptions
 * @property {string} file - absolute path to the database
 * @property {number} port
 * @property {string} host
 * @property {string[]} staticDirs
 * @property {boolean} watch
 * @property {boolean} sync
 * @property {boolean} quiet
 * @property {boolean} color
 * @property {boolean} help
 * @property {boolean} version
 */

/**
 * Turn argv into options. Pure: it resolves paths and validates numbers but
 * never touches the network and never exits.
 *
 * @param {string[]} argv - arguments after the node binary and script
 * @param {{cwd?: string, env?: Record<string, string|undefined>}} [context]
 * @returns {CliOptions}
 */
export function parseCliArgs(argv, { cwd = process.cwd(), env = process.env } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        static: { type: 'string', short: 's', multiple: true },
        watch: { type: 'boolean', short: 'w', default: false },
        sync: { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        'no-color': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    // parseArgs throws for unknown flags and missing values; its message is
    // already specific, so pass it through rather than inventing our own.
    throw new Error(`${error.message}\n\n${USAGE}`);
  }

  const { values, positionals } = parsed;
  if (positionals.length > 1) {
    throw new Error(`Expected at most one database file, got ${positionals.length}`);
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535, got "${values.port}"`);
  }

  const staticDirs = (values.static ?? []).map((dir) => resolve(cwd, dir));
  if (staticDirs.length === 0) {
    const fallback = resolve(cwd, DEFAULT_STATIC_DIR);
    if (existsSync(fallback)) staticDirs.push(fallback);
  }

  return {
    file: resolve(cwd, positionals[0] ?? DEFAULT_DB),
    port,
    host: values.host ?? DEFAULT_HOST,
    staticDirs,
    watch: values.watch,
    sync: values.sync,
    quiet: values.quiet,
    color: shouldUseColor({ noColor: values['no-color'], env }),
    help: values.help,
    version: values.version,
  };
}

/**
 * Lines describing what is being served, printed once at startup.
 *
 * @param {CliOptions} options
 * @param {import('./store.js').Store} store
 * @param {string} origin
 * @param {import('./logger.js').Logger} logger
 * @returns {string}
 */
export function formatBanner(options, store, origin, logger) {
  const { paint } = logger;
  const lines = [
    '',
    `  ${paint('bold', 'mocksmith')} ${paint('dim', VERSION)}`,
    '',
    `  ${paint('dim', 'Database')}  ${store.file}`,
    `  ${paint('dim', 'Endpoint')}  ${paint('cyan', origin)}`,
    '',
  ];

  for (const resource of store.resources()) {
    const detail = resource.type === 'collection' ? `${resource.count} items` : 'object';
    lines.push(`    ${paint('green', `/${resource.name}`.padEnd(20))} ${paint('dim', detail)}`);
  }

  lines.push('', `  ${paint('dim', 'Press Ctrl+C to stop')}`, '');
  return lines.join('\n');
}

/**
 * Start the server and resolve once it is listening.
 *
 * @param {CliOptions} options
 * @param {import('./logger.js').Logger} logger
 * @returns {Promise<{server: import('node:http').Server, store: import('./store.js').Store, origin: string}>}
 */
export async function start(options, logger) {
  const store = await Store.load(options.file, {
    sync: options.sync,
    watch: options.watch,
    // Background write and watch failures have no request to be reported on,
    // so they surface here instead of vanishing.
    onError: (error) => logger.error(error),
  });
  store.onReload(() => logger.info(`  ${logger.paint('dim', 'Reloaded')} ${store.file}`));

  const server = createServer(store, { logger, ...options });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });

  // The port comes from the socket, because --port 0 means "whatever is free".
  // The host is echoed back as the user wrote it: printing the resolved address
  // would turn `--host localhost` into an unhelpful `http://[::1]:3000`.
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  const displayHost = formatHost(options.host);

  return { server, store, origin: `http://${displayHost}:${port}` };
}

/**
 * Render a host as a URL authority: wildcards become something dialable, and a
 * bare IPv6 literal needs brackets.
 *
 * @param {string} host
 * @returns {string}
 */
function formatHost(host) {
  if (host === '0.0.0.0' || host === '::' || host === '') return 'localhost';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Stop accepting connections, let in-flight requests finish, then release the
 * database. Idle keep-alive sockets are closed at once — they are holding the
 * listener open for nothing.
 *
 * @param {import('node:http').Server} server
 * @param {import('./store.js').Store} store
 * @param {{graceMs?: number}} [options]
 * @returns {Promise<void>}
 */
export async function shutdown(server, store, { graceMs = SHUTDOWN_GRACE_MS } = {}) {
  await new Promise((resolvePromise) => {
    const forced = setTimeout(() => server.closeAllConnections(), graceMs);
    forced.unref();
    server.close(() => {
      clearTimeout(forced);
      resolvePromise();
    });
    server.closeIdleConnections();
  });
  await store.close();
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2)) {
  /** @type {CliOptions} */
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const logger = createLogger({ quiet: options.quiet, color: options.color });

  let started;
  try {
    started = await start(options, logger);
  } catch (error) {
    if (error instanceof DatabaseError) {
      logger.error(error.message);
      return 1;
    }
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${options.port} is already in use`);
      return 1;
    }
    logger.error(error);
    return 1;
  }

  const { server, store, origin } = started;
  logger.info(formatBanner(options, store, origin, logger));

  if (options.staticDirs.length > 0) {
    // Accepted now so the flag is stable; static serving lands in a later
    // milestone. Saying so is better than pretending it took effect.
    logger.warn('--static is not wired up yet in this build');
  }

  await new Promise((resolvePromise) => {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        logger.info(`\n  Shutting down (${signal})`);
        shutdown(server, store).then(resolvePromise, (error) => {
          logger.error(error);
          resolvePromise();
        });
      });
    }
  });

  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
