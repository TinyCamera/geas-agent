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
export {
  BINDING_MODES,
  type BindingMode,
  type AgentBinding,
  type CreateBindingInput,
  createBinding,
  isBindingMode,
  isAgentControlled,
} from "./binding/index.js";
export {
  type CacheControl,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
  type LlmRole,
  type LlmMessage,
  type LlmToolDef,
  type StopReason,
  type LlmUsage,
  type GenerateRequest,
  type GenerateResult,
  type LlmErrorKind,
  type LlmError,
  type LlmOk,
  type LlmErr,
  type LlmResult,
  type StreamEvent,
  type LlmProvider,
  llmOk,
  llmErr,
  makeLlmError,
  isTextBlock,
  isToolUseBlock,
  isToolResultBlock,
  ZERO_USAGE,
  NoopProvider,
  type NoopProviderOptions,
  type ScriptedTurn,
} from "./llm/index.js";
export {
  PLAN_THEN_ACT_INSTRUCTIONS,
  composeSystemPrompt,
  parseTurnIntents,
  intentForToolUse,
  type ParsedToolIntent,
  type ParsedTurnIntents,
  buildRecoveryPrompt,
  type ToolCallFailure,
  type BuildRecoveryPromptInput,
} from "./prompts/index.js";
export {
  runWithRetry,
  type AttemptPlan,
  type RecoveryContext,
  type RecoveryDriver,
  type RunWithRetryInput,
  type RunWithRetryOutcome,
  type RunWithRetryOk,
  type RunWithRetryStuck,
  type RunWithRetryExhausted,
  type RunWithRetryGaveUp,
} from "./loop/index.js";

const banner = "geas-agent online — MCP client ready";

export function getBanner(): string {
  return banner;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(getBanner());
}
