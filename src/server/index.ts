/**
 * Channel-A server (issue #667). Public surface.
 */

export {
  PROTOCOL_VERSION,
  type ChannelAEvent,
  type EventEnvelope,
  type TextEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type NarrationEvent,
  type DecisionEvent,
  type ErrorEvent,
  type DoneEvent,
  type HelloEvent,
  type PingEvent,
  type TelemetryEvent,
  type ChatRequest,
  type ChatAccepted,
  type ApiError,
  type ResolveDecisionRequest,
  type SessionListingRow,
  type ListSessionsResponse,
  type SyncChatResponse,
  type SyncChatTimeoutResponse,
} from './wire.js';

export {
  assembleTurn,
  type TurnResult,
  type TurnStopReason,
  type TurnResultToolCall,
  type TurnResultToolResult,
  type TurnResultDecision,
} from './assemble-turn.js';

export {
  type TokenVerifier,
  REJECT_ALL_VERIFIER,
  StaticDevVerifier,
  FirebaseTokenVerifier,
} from './auth.js';

export { EventBuffer } from './event-buffer.js';
export { EventHub, type HubOptions, type Subscriber } from './hub.js';
export {
  SessionRegistry,
  type SessionFactory,
} from './session-registry.js';
export {
  createServer,
  type ServerOptions,
  type RunningServer,
} from './server.js';
export {
  createTelemetrySink,
  wrapLlmWithTelemetry,
  telemetryTag,
} from './telemetry-sink.js';
