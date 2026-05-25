/**
 * Recovery-prompt builder — composes the user-turn text the agent loop
 * feeds back after a tool call fails, surfacing the model's prior intent
 * so it retries the *goal*, not the failed *mechanic*.
 *
 * Inputs come from three places in the loop:
 *   - The failed tool's name + the arguments the model produced (from the
 *     `tool_use` block).
 *   - A failure reason (validator error from #658, MCP `tool_error` from
 *     `GeasMcpClient.callTool`, or a partial-act outcome the harness chose
 *     to escalate).
 *   - The intent the parser (`intent.ts`) extracted for that tool_use.
 *
 * Output is a single string suitable as the text content of a `user` turn.
 * The agent loop wraps it in the appropriate `ToolResultBlock` /
 * `TextBlock` envelope when assembling the next message — that envelope
 * choice (tool_result vs free-text user) is a loop-policy concern and
 * lives in the loop, not here.
 */

/** Why a tool call failed, in shape-agnostic form. */
export interface ToolCallFailure {
  /** Tool name as the model invoked it (may not exist on the server). */
  readonly toolName: string;
  /** Arguments the model produced. May be partial or wrong-shape. */
  readonly args: Record<string, unknown>;
  /**
   * Human-readable failure reason. Examples:
   *   - "missing required argument 'targetEntityId'"
   *   - "tool_error: target out of range"
   *   - "transport: connection lost"
   * Keep it one line; the builder formats around it.
   */
  readonly reason: string;
  /**
   * Optional category for telemetry / future templating
   * (`validator | tool_error | transport | timeout | unknown_tool | other`).
   * Not surfaced to the model directly — the `reason` string is the
   * model-visible bit — but recorded on the in-memory turn record.
   */
  readonly category?: string;
}

export interface BuildRecoveryPromptInput {
  readonly failure: ToolCallFailure;
  /**
   * The intent the model declared on the failed turn. `null` covers both
   * `Intent: none` and "missing" (parser couldn't find an Intent line) —
   * the recovery prompt nudges the model to declare one next time.
   */
  readonly priorIntent: string | null;
}

/**
 * Cap arg JSON in the prompt at this many characters. The model produced
 * the args itself this same turn, so re-echoing them verbatim is just a
 * mirror; we include them for unambiguous "this exact call failed" framing
 * but truncate to keep the recovery prompt small in the context window.
 */
const ARG_ECHO_MAX_CHARS = 400;

function echoArgs(args: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    // Circular / non-serializable — fall back to a placeholder rather than
    // throwing. The model rarely produces such args (its tool_use input is
    // JSON to begin with), but the loop shouldn't crash on edge cases.
    json = '<unserializable args>';
  }
  if (json.length > ARG_ECHO_MAX_CHARS) {
    return `${json.slice(0, ARG_ECHO_MAX_CHARS)}… (truncated)`;
  }
  return json;
}

/**
 * Build the recovery prompt text. Output shape:
 *
 *   Your call to <toolName> failed.
 *     args:   {...}
 *     reason: <reason>
 *   Your prior intent was: "<intent>"
 *   Try a different approach to that intent — do not repeat the failed call.
 *
 * When `priorIntent` is null, the "prior intent" line is replaced with a
 * nudge to declare one on the retry.
 */
export function buildRecoveryPrompt(input: BuildRecoveryPromptInput): string {
  const { failure, priorIntent } = input;
  const lines: string[] = [];
  lines.push(`Your call to \`${failure.toolName}\` failed.`);
  lines.push(`  args:   ${echoArgs(failure.args)}`);
  lines.push(`  reason: ${failure.reason}`);
  if (priorIntent && priorIntent.trim().length > 0) {
    lines.push(`Your prior intent was: "${priorIntent.trim()}"`);
    lines.push(
      'Try a different approach to that intent — do not repeat the failed call.',
    );
  } else {
    lines.push(
      'You did not declare an Intent on the failed turn. On your retry, ' +
        'emit `Intent: <one line>` before the tool_use so failure recovery ' +
        'can be targeted, then try a different approach.',
    );
  }
  return lines.join('\n');
}
