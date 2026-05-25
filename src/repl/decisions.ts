/**
 * Interactive decision-event rendering + input parsing (issue #649).
 *
 * The agent emits `decision` events when it needs the user to pick from a
 * curated set of options (level-up skill choice, build picker, fresh
 * character creation). The REPL turns each event into a numbered prompt,
 * reads a digit on stdin, and posts the choice back to Channel A via
 * `POST /resolve-decision`.
 *
 * **Wire compromise.** Channel A's `ResolveDecisionRequest` from #667
 * carries a free-form `text` field, not a structured `{optionId}`. We
 * serialise the chosen option (or character-creation envelope) into that
 * field — the agent's loop parses it back out. See `serializeChoice` for
 * the exact shape. This lets us round-trip without forcing a wire-protocol
 * bump on #667.
 *
 * **Defensive on payload.** `DecisionEvent.payload` is `unknown` on the
 * wire. We typeguard it and fall back to a generic numbered list when the
 * shape doesn't match the ticket's expected superset. Never crash, never
 * drop a decision.
 *
 * **Out of scope.** Multi-decision concurrency (one at a time is fine);
 * inventory / vendor / quest-dialog modals (future epics).
 */

export interface DecisionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: Record<string, unknown>;
}

export interface ParsedDecisionPayload {
  readonly kind: 'level_up' | 'build_picker' | 'character_creation' | 'unknown';
  readonly rawKind: string;
  readonly options: readonly DecisionOption[];
  readonly stats?: readonly StatSpec[];
  readonly statBudget?: number;
  readonly deadlineMs?: number;
}

export interface StatSpec {
  readonly id: string;
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
}

/**
 * Active decision state held by the CLI between the prompt render and the
 * user's input line. `character_creation` is multi-step — `stage` advances
 * stat → build → done as the user supplies input.
 */
export type DecisionState =
  | {
      readonly kind: 'simple';
      readonly decisionId: string;
      readonly parsed: ParsedDecisionPayload;
    }
  | {
      readonly kind: 'character_creation';
      readonly decisionId: string;
      readonly parsed: ParsedDecisionPayload;
      readonly stage: 'stats' | 'build';
      readonly statValues: Readonly<Record<string, number>>;
    };

const DEFAULT_STATS: readonly StatSpec[] = [
  { id: 'STR', label: 'Strength', min: 1, max: 10 },
  { id: 'AGI', label: 'Agility', min: 1, max: 10 },
  { id: 'INT', label: 'Intellect', min: 1, max: 10 },
  { id: 'CHA', label: 'Charisma', min: 1, max: 10 },
];
const DEFAULT_STAT_BUDGET = 20;

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseOption(raw: unknown, index: number): DecisionOption | null {
  const o = asObject(raw);
  if (!o) return null;
  const id = asString(o.id) ?? `opt-${index + 1}`;
  const label = asString(o.label) ?? id;
  const description = asString(o.description) ?? undefined;
  const detail = asObject(o.detail) ?? undefined;
  return { id, label, description, detail };
}

function parseStatSpec(raw: unknown, fallback: StatSpec): StatSpec {
  const o = asObject(raw);
  if (!o) return fallback;
  return {
    id: asString(o.id) ?? fallback.id,
    label: asString(o.label) ?? fallback.label,
    min: asNumber(o.min) ?? fallback.min,
    max: asNumber(o.max) ?? fallback.max,
  };
}

/**
 * Best-effort decode of a `DecisionEvent.payload` into the renderer's
 * internal shape. Unknown kinds get `kind: 'unknown'` with whatever
 * options we could parse; an empty/missing payload yields an empty
 * options list (the renderer prints a fallback line).
 */
export function parsePayload(raw: unknown): ParsedDecisionPayload {
  const obj = asObject(raw);
  const rawKind = (obj && asString(obj.kind)) ?? 'unknown';
  const kind: ParsedDecisionPayload['kind'] =
    rawKind === 'level_up' ||
    rawKind === 'build_picker' ||
    rawKind === 'character_creation'
      ? rawKind
      : 'unknown';

  const opts: DecisionOption[] = [];
  if (obj && Array.isArray(obj.options)) {
    obj.options.forEach((raw, i) => {
      const o = parseOption(raw, i);
      if (o) opts.push(o);
    });
  }

  const deadlineMs = obj ? asNumber(obj.deadlineMs) ?? undefined : undefined;

  if (kind === 'character_creation') {
    const statsRaw = obj && Array.isArray(obj.stats) ? obj.stats : null;
    const stats: StatSpec[] = statsRaw
      ? statsRaw.map((s, i) =>
          parseStatSpec(s, DEFAULT_STATS[i] ?? { id: `stat-${i}`, label: `Stat ${i + 1}` }),
        )
      : [...DEFAULT_STATS];
    return {
      kind,
      rawKind,
      options: opts,
      stats,
      statBudget: (obj && asNumber(obj.statBudget)) ?? DEFAULT_STAT_BUDGET,
      deadlineMs,
    };
  }

  return { kind, rawKind, options: opts, deadlineMs };
}

// ---------- rendering ----------

/**
 * Render the initial prompt block for a decision. Returns an array of
 * lines (no trailing newlines) the CLI flushes plus a `state` describing
 * the active decision the CLI must route the next stdin line into.
 */
export function renderInitialPrompt(
  decisionId: string,
  payload: unknown,
): { readonly lines: readonly string[]; readonly state: DecisionState } {
  const parsed = parsePayload(payload);

  if (parsed.kind === 'character_creation') {
    const state: DecisionState = {
      kind: 'character_creation',
      decisionId,
      parsed,
      stage: 'stats',
      statValues: {},
    };
    return { lines: renderStatPrompt(state), state };
  }

  const lines = renderOptionsList(parsed);
  return {
    lines,
    state: { kind: 'simple', decisionId, parsed },
  };
}

function renderOptionsList(parsed: ParsedDecisionPayload): string[] {
  const lines: string[] = [];
  const header =
    parsed.kind === 'level_up'
      ? 'Level up — pick one:'
      : parsed.kind === 'build_picker'
        ? 'Choose your build:'
        : parsed.kind === 'unknown'
          ? `Decision (${parsed.rawKind}) — pick one:`
          : 'Decision — pick one:';
  lines.push(header);

  if (parsed.options.length === 0) {
    lines.push('  (no options — type q to skip)');
    return lines;
  }
  parsed.options.forEach((opt, i) => {
    const tag = `[${i + 1}]`;
    const desc = opt.description ? ` — ${opt.description}` : '';
    lines.push(`  ${tag} ${opt.label}${desc}`);
  });
  lines.push('Pick 1-' + parsed.options.length + ' (q to cancel):');
  return lines;
}

function renderStatPrompt(
  state: Extract<DecisionState, { kind: 'character_creation' }>,
): string[] {
  const { parsed, statValues } = state;
  const stats = parsed.stats ?? [];
  const spent = Object.values(statValues).reduce((s, v) => s + v, 0);
  const budget = parsed.statBudget ?? 0;
  const remaining = budget - spent;

  const lines: string[] = [];
  lines.push(`Character creation — allocate stats (${remaining}/${budget} remaining):`);
  for (const s of stats) {
    const v = statValues[s.id];
    const tag = v !== undefined ? String(v) : '_';
    const range = s.min !== undefined && s.max !== undefined ? ` (${s.min}-${s.max})` : '';
    lines.push(`  ${s.id} ${s.label}${range}: ${tag}`);
  }
  // Find next unset stat to prompt for.
  const next = stats.find((s) => statValues[s.id] === undefined);
  if (next) {
    lines.push(`Enter value for ${next.id} (q to cancel):`);
  } else {
    lines.push('Type "done" to confirm, or "reset" to start over:');
  }
  return lines;
}

function renderBuildPrompt(
  state: Extract<DecisionState, { kind: 'character_creation' }>,
): string[] {
  return renderOptionsList({
    ...state.parsed,
    kind: 'build_picker',
  });
}

// ---------- input parsing ----------

export type DecisionInput =
  | { readonly kind: 'select'; readonly optionId: string; readonly nextState: null }
  | { readonly kind: 'stat-progress'; readonly nextState: DecisionState; readonly lines: readonly string[] }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'invalid'; readonly reason: string; readonly lines: readonly string[] };

/**
 * Drive the next stdin line into the active decision. Returns either:
 *   - a terminal `select` with `optionId` to ship over the wire,
 *   - a non-terminal `stat-progress` carrying updated state + lines to
 *     reprompt with (character_creation stat-by-stat input),
 *   - `cancel` if the user typed q / quit / cancel,
 *   - `invalid` with a re-prompt block (don't crash the REPL).
 */
export function applyDecisionInput(
  state: DecisionState,
  raw: string,
): DecisionInput {
  const line = raw.trim();
  if (line === 'q' || line === 'quit' || line === 'cancel') {
    return { kind: 'cancel' };
  }

  if (state.kind === 'simple') {
    return applySimpleSelect(state, line);
  }

  // character_creation
  if (state.stage === 'stats') {
    return applyStatInput(state, line);
  }
  // stage === 'build'
  const res = applySimpleSelect(
    { kind: 'simple', decisionId: state.decisionId, parsed: { ...state.parsed, kind: 'build_picker' } },
    line,
  );
  if (res.kind === 'select') {
    // Compose the character_creation envelope.
    return {
      kind: 'select',
      optionId: JSON.stringify({
        stats: state.statValues,
        build: res.optionId,
      }),
      nextState: null,
    };
  }
  if (res.kind === 'invalid') {
    return {
      kind: 'invalid',
      reason: res.reason,
      lines: [res.reason, ...renderBuildPrompt(state)],
    };
  }
  return res;
}

function applySimpleSelect(
  state: Extract<DecisionState, { kind: 'simple' }>,
  line: string,
): DecisionInput {
  const n = parseNumber(line);
  const opts = state.parsed.options;
  if (n === null) {
    return {
      kind: 'invalid',
      reason: `Not a number: "${line}".`,
      lines: [`Not a number: "${line}".`, ...renderOptionsList(state.parsed)],
    };
  }
  if (n < 1 || n > opts.length) {
    return {
      kind: 'invalid',
      reason: `Out of range: ${n}.`,
      lines: [`Out of range: ${n}.`, ...renderOptionsList(state.parsed)],
    };
  }
  return { kind: 'select', optionId: opts[n - 1].id, nextState: null };
}

function applyStatInput(
  state: Extract<DecisionState, { kind: 'character_creation' }>,
  line: string,
): DecisionInput {
  const stats = state.parsed.stats ?? [];
  const next = stats.find((s) => state.statValues[s.id] === undefined);

  if (!next) {
    // All stats set — accept "done" or "reset".
    if (line === 'done') {
      const nextState: DecisionState = { ...state, stage: 'build' };
      return {
        kind: 'stat-progress',
        nextState,
        lines: renderBuildPrompt(nextState),
      };
    }
    if (line === 'reset') {
      const nextState: DecisionState = { ...state, statValues: {} };
      return {
        kind: 'stat-progress',
        nextState,
        lines: renderStatPrompt(nextState),
      };
    }
    return {
      kind: 'invalid',
      reason: `Expected "done" or "reset".`,
      lines: [`Expected "done" or "reset".`, ...renderStatPrompt(state)],
    };
  }

  const n = parseNumber(line);
  if (n === null) {
    return {
      kind: 'invalid',
      reason: `Not a number: "${line}".`,
      lines: [`Not a number: "${line}".`, ...renderStatPrompt(state)],
    };
  }
  if (next.min !== undefined && n < next.min) {
    return {
      kind: 'invalid',
      reason: `${next.id} below min (${next.min}).`,
      lines: [`${next.id} below min (${next.min}).`, ...renderStatPrompt(state)],
    };
  }
  if (next.max !== undefined && n > next.max) {
    return {
      kind: 'invalid',
      reason: `${next.id} above max (${next.max}).`,
      lines: [`${next.id} above max (${next.max}).`, ...renderStatPrompt(state)],
    };
  }
  // Budget check across the (would-be) full allocation.
  const spent = Object.values(state.statValues).reduce((s, v) => s + v, 0) + n;
  const budget = state.parsed.statBudget ?? Infinity;
  if (spent > budget) {
    return {
      kind: 'invalid',
      reason: `Over budget: ${spent}/${budget}.`,
      lines: [`Over budget: ${spent}/${budget}.`, ...renderStatPrompt(state)],
    };
  }

  const nextValues = { ...state.statValues, [next.id]: n };
  const nextState: DecisionState = { ...state, statValues: nextValues };
  return {
    kind: 'stat-progress',
    nextState,
    lines: renderStatPrompt(nextState),
  };
}

/** Accepts "1", "1.", " 1 ", rejects "1a", "" etc. */
export function parseNumber(line: string): number | null {
  const t = line.trim().replace(/\.$/, '');
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ---------- wire serialization ----------

/**
 * Convert a parsed user choice into the `text` field of a
 * `ResolveDecisionRequest`. For simple decisions this is just the
 * optionId; for character_creation it's the JSON envelope produced by
 * `applyDecisionInput`. Timeout is a sentinel envelope so the agent can
 * branch on it.
 */
export function serializeChoice(input: { readonly optionId: string }): string {
  return input.optionId;
}

export function serializeTimeout(): string {
  return JSON.stringify({ timeout: true });
}

export function serializeCancel(): string {
  return JSON.stringify({ cancelled: true });
}
