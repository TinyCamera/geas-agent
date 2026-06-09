/**
 * Verification harness public surface (#673, parent #589).
 *
 * The harness boots a geas-agent against a (fake or live) geas-server and
 * drives it through scripted {@link VerifyScenario}s with a real or scripted
 * LLM, asserting on resulting server state and reporting cost. See
 * `src/verify/types.ts` for the contract and `npm run test:verify` (`cli.ts`)
 * for the runnable entry. The standard scenario set lands with #674.
 */

export * from './types.js';
export { createFakeWorld } from './fake-world.js';
export { createLiveWorld, type LiveWorldOptions } from './live-world.js';
export { runVerifyScenario, type RunVerifyOptions } from './runner.js';
export { formatReport, formatRun } from './report.js';
export {
  VERIFY_SCENARIOS,
  createVerifyRegistry,
} from './scenarios/index.js';
export { smoke } from './scenarios/smoke.js';
