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
  fetchSessions,
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
  runList,
  readConfigFromEnv,
  type CliConfig,
  type CliIo,
  type CliHandles,
} from './cli.js';
export { parseArgs, USAGE, type ParsedArgs } from './args.js';
export {
  renderListing,
  clip,
  formatCost,
  formatLastActive,
} from './listing.js';
