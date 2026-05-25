/**
 * CLI arg parsing for the REPL (#650).
 *
 * Recognised flags (mutually exclusive — combinations error out before any
 * network I/O):
 *
 *   --list                   list sessions and exit
 *   --session <id>           resume a named session
 *   --new                    start a fresh session (equivalent to no flag)
 *   --help / -h              print usage and exit 0
 *
 * Unknown flags are a 1-line error (so a typo never silently spawns a fresh
 * REPL connected to nothing).
 */

export type ParsedArgs =
  | { readonly mode: 'help' }
  | { readonly mode: 'list' }
  | { readonly mode: 'resume'; readonly sessionId: string }
  | { readonly mode: 'new' }
  | { readonly mode: 'error'; readonly message: string };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      flags.set('help', true);
      continue;
    }
    if (a === '--list') {
      flags.set('list', true);
      continue;
    }
    if (a === '--new') {
      flags.set('new', true);
      continue;
    }
    if (a === '--session') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return {
          mode: 'error',
          message: '--session requires a session id argument',
        };
      }
      flags.set('session', next);
      i += 1;
      continue;
    }
    return { mode: 'error', message: `unknown arg: ${a}` };
  }

  if (flags.has('help')) return { mode: 'help' };

  const exclusive = ['list', 'session', 'new'].filter((f) => flags.has(f));
  if (exclusive.length > 1) {
    return {
      mode: 'error',
      message: `flags are mutually exclusive: ${exclusive
        .map((f) => '--' + f)
        .join(', ')}`,
    };
  }

  if (flags.has('list')) return { mode: 'list' };
  if (flags.has('session')) {
    return { mode: 'resume', sessionId: flags.get('session') as string };
  }
  return { mode: 'new' };
}

export const USAGE = `Usage: npm run repl -- [--list | --session <id> | --new]

  --list             List sessions for the current GEAS_DEV_UID and exit.
  --session <id>     Resume a previously-stored session by id.
  --new              Start a fresh session (default if no flag given).
  -h, --help         Show this help.

Env:
  GEAS_AGENT_URL        default http://127.0.0.1:8090
  GEAS_AGENT_TOKEN      required — bearer token
  GEAS_AGENT_CHARACTER  required except for --list
`;
