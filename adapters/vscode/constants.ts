// ── User-Level Layout Persistence (re-exports from server/) ──
export {
  CONFIG_FILE_NAME,
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_NAME,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  LAYOUT_REVISION_KEY,
} from '../../server/src/constants.js';

// ── Settings Persistence (VS Code globalState keys) ─────────
export const GLOBAL_KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
export const GLOBAL_KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
export const GLOBAL_KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
export const GLOBAL_KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
export const GLOBAL_KEY_HOOKS_ENABLED = 'pixel-agents.hooksEnabled';
export const GLOBAL_KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';

// ── VS Code Settings (contributes.configuration keys) ───────
export const CONFIG_KEY_AUTO_SHOW_PANEL = 'pixel-agents.autoShowPanel';
export const CONFIG_KEY_AUTO_SPAWN_AGENT = 'pixel-agents.autoSpawnAgent';
export const CONFIG_KEY_LAUNCH_MODE = 'pixel-agents.launchMode';
export const CONFIG_KEY_AGENT_NAMES = 'pixel-agents.agentNames';
export const CONFIG_KEY_HOOK_EVENT_MODE = 'pixel-agents.hookEventMode';

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = 'pixel-agents.panelView';
export const COMMAND_SHOW_PANEL = 'pixel-agents.showPanel';
export const COMMAND_EXPORT_DEFAULT_LAYOUT = 'pixel-agents.exportDefaultLayout';
export const COMMAND_DISPATCH_INTERN = 'pixel-agents.dispatchIntern';

// ── Claude Code Integration (tab launch mode) ────────────────
/** Command exposed by the Claude Code extension to open a session as an editor tab. */
export const CLAUDE_CODE_EDITOR_OPEN_COMMAND = 'claude-vscode.editor.open';
/** First prompt sent to a newly-opened tab. The "(Name)" prefix is the
 *  correlation key the pending-spawn registry matches against UserPromptSubmit,
 *  and the instruction asks the model to keep it in any AI-generated tab title. */
export const TAB_SPAWN_FIRST_PROMPT_TEMPLATE =
  '({name}) reporting for duty. Your agent name is {name}. When you or the system ' +
  'generate a title for this session, keep "({name}) " at the start of the title. ' +
  'Wait for my instructions.';
/** First prompt for intern dispatch (chore task text is appended). Must start
 *  with "({name})" — same correlation contract as TAB_SPAWN_FIRST_PROMPT_TEMPLATE. */
export const INTERN_FIRST_PROMPT_PREFIX =
  '({name}) intern reporting for duty. My name is {name}. Keep "({name}) " at the ' +
  'start of any title generated for this session. Complete the following task now, ' +
  'then end with a short report. Task: ';

// ── Webview Broadcast Batching ────────────────────────────────
/** High-frequency messages coalesced into a single `batch` postMessage instead
 *  of being sent one at a time. Everything else (agent lifecycle, permission
 *  prompts, layout/assets/settings) is latency-sensitive and stays immediate. */
export const BATCHABLE_MESSAGE_TYPES = new Set([
  'agentToolStart',
  'agentToolDone',
  'agentStatus',
  'agentTokenUsage',
  'subagentToolStart',
  'subagentToolDone',
  'agentToolsClear',
  'subagentClear',
  'agentTeamInfo',
]);
/** Delay before flushing the queued batchable messages as one `batch` message. */
export const BATCH_FLUSH_DELAY_MS = 50;
