/**
 * Console output. Colour comes from `node:util`'s styleText, so there is no
 * escape-code table to maintain and no dependency to install.
 */
import { styleText } from 'node:util';

/**
 * @typedef {object} Logger
 * @property {(styles: string|string[], text: string) => string} paint
 * @property {(message: string) => void} info
 * @property {(message: string) => void} warn
 * @property {(error: unknown) => void} error
 */

/**
 * Build a logger.
 *
 * `quiet` silences informational output only. Errors always reach stderr —
 * swallowing them would hide real bugs behind a flag.
 *
 * @param {{quiet?: boolean, color?: boolean, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream}} [options]
 * @returns {Logger}
 */
export function createLogger({
  quiet = false,
  color = true,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const paint = (styles, text) => (color ? styleText(styles, text) : text);

  return {
    paint,
    info(message) {
      if (!quiet) stdout.write(`${message}\n`);
    },
    warn(message) {
      if (!quiet) stderr.write(`${paint('yellow', 'warn')}  ${message}\n`);
    },
    error(error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      stderr.write(`${paint('red', 'error')} ${detail}\n`);
    },
  };
}

/**
 * Colour is off when the user asked for `--no-color`, when NO_COLOR is set (the
 * no-color.org convention), or when stdout is not a terminal — piping output
 * into a file should not fill it with escape codes.
 *
 * @param {{noColor?: boolean, env?: Record<string, string|undefined>, stream?: {isTTY?: boolean}}} [options]
 * @returns {boolean}
 */
export function shouldUseColor({ noColor = false, env = process.env, stream = process.stdout } = {}) {
  if (noColor) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return Boolean(stream.isTTY);
}
