/**
 * Claude-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider `server/` build doesn't accidentally depend on Claude
 * unless Claude is the active provider.
 *
 * Adding another provider? Create its own `providers/<kind>/<name>/constants.ts`.
 */

/** Output filename after esbuild compiles claude-hook.ts to CJS (source is .ts, output is .js) */
export const CLAUDE_HOOK_SCRIPT_NAME = 'claude-hook.js';

/** Full hook event set to install in ~/.claude/settings.json.
 *  SessionStart/SessionEnd handle session lifecycle (start, /clear, resume, exit).
 *  Stop/PermissionRequest/Notification handle turn completion and permission UI.
 *  SubagentStart/SubagentStop/TeammateIdle/TaskCreated/TaskCompleted power Agent Teams. */
export const CLAUDE_HOOK_EVENTS_FULL = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'Notification',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
] as const;

/** Minimal hook event set (default): lifecycle-only, zero per-tool-call overhead.
 *  Tool start/done activity instead comes from JSONL transcript polling.
 *  UserPromptSubmit is REQUIRED — it's the pending-spawn correlation primary. */
export const CLAUDE_HOOK_EVENTS_MINIMAL = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'Notification',
  'PermissionRequest',
  'UserPromptSubmit',
] as const;

/** Back-compat alias of the full event set. */
export const CLAUDE_HOOK_EVENTS = CLAUDE_HOOK_EVENTS_FULL;

/** Terminal name prefix used when launching Claude Code in VS Code.
 *  Used by the extension to match terminals to agents for adoption. */
export const CLAUDE_TERMINAL_NAME_PREFIX = 'Claude Code';
