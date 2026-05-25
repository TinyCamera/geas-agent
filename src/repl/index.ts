/**
 * REPL public surface (issue #648).
 *
 * Re-exports the transport client + renderer so:
 *   - The web client (#592) can import `Transport` directly and ignore
 *     the CLI module.
 *   - Tests can drive `renderEvent` without spinning a process.
 */
export {
  Transport,
  parseEventFrame,
  type TransportOptions,
  type TransportEvent,
  type TransportListener,
} from './transport.js';
export {
  renderEvent,
  renderTelemetryLine,
  type RenderOptions,
  type RenderPiece,
} from './render.js';
export {
  runRepl,
  readConfigFromEnv,
  type CliConfig,
  type CliIo,
  type CliHandles,
} from './cli.js';
