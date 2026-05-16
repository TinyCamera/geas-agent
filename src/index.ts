/**
 * geas-agent — public entrypoint.
 *
 * Exports the MCP client wrapper used to talk to a running geas-server. The
 * agent loop (LLM provider, identity, deploy) is intentionally out of scope
 * for this slice — see epics #584/#586/#587/#588/#589/#590.
 */

export {
  GeasMcpClient,
  type GeasMcpClientOptions,
} from "./mcp/index.js";
export {
  type GeasMcpError,
  type GeasMcpErrorKind,
  type Result,
  type Ok,
  type Err,
  ok,
  err,
  makeError,
  GEAS_TOOL_NAMES,
  type GeasToolName,
  type GeasToolResponse,
} from "./mcp/index.js";

const banner = "geas-agent online — MCP client ready";

export function getBanner(): string {
  return banner;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(getBanner());
}
