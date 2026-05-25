/**
 * Memory summarisation public surface (#666).
 */

export {
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_THRESHOLD_TOKENS,
  LlmConversationSummarizer,
  buildSummaryMessage,
  decideSummarisation,
  estimateBufferTokens,
  estimateTurnTokens,
  renderTurnsForSummary,
  summariseIfNeeded,
  type ConversationSummarizer,
  type LlmConversationSummarizerOptions,
  type StructuredSummary,
  type SummarisationDecision,
  type SummarisationOutcome,
  type SummariseIfNeededInput,
  type SummariseThresholdInput,
  type SummarizeResult,
} from './summarizer.js';
