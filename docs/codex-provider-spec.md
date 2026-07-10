# Codex CLI Provider — Implementation Spec

Target: add OpenAI Codex CLI as a second agent provider so Codex sessions render as
characters alongside Claude Code sessions. The architecture already isolates CLI
specifics behind `HookProvider` (`core/src/provider.ts`); per `CLAUDE.md`, a new CLI
is one subdirectory under `server/src/providers/hook/<id>/` plus registry wiring.

Verified against Codex CLI **0.142.5** (`codex-cli 0.142.5`, hooks feature `stable true`)
on this machine, 2026-07-10.

---

## 1. Codex integration surface (researched facts)

### Hooks (primary signal — use these)

Codex has a Claude-Code-style lifecycle hook system, configured in `~/.codex/hooks.json`
(or `[hooks]` tables in `~/.codex/config.toml`; project-level `.codex/hooks.json` exists
but is trust-gated — use the user-level file).

Events: `SessionStart`, `SubagentStart`, `PreToolUse`, `PermissionRequest`,
`PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`.

**There is no SessionEnd event.** `Stop` fires at turn completion.

Hook stdin payload (all events): `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model`, `permission_mode`. Turn-scoped events add `turn_id`;
tool events add `tool_name`, `tool_use_id`, `tool_input` (+ `tool_response` on Post);
`SessionStart` adds `source`.

**Trust caveat:** non-managed command hooks require one-time approval via `/hooks`
inside the Codex TUI (or `--dangerously-bypass-hook-trust` per invocation). The
installer must surface this: after writing hooks.json, show a one-time notice that the
user must approve the hook in Codex before events flow. Do not attempt to bypass.

### `notify` (do not use)

`notify = [...]` in config.toml fires only `agent-turn-complete`. Superseded by hooks;
skip it.

### Session transcripts (fallback + tool-animation tail)

- Rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-mm-ss-<uuidv7>.jsonl`.
  The UUIDv7 in the filename IS the session id. Dirs are **date-based, not
  project-based** — the project/cwd is only inside the file (`session_meta` line 1).
- Session index: `~/.codex/session_index.jsonl` — one line per session
  `{"id","thread_name","updated_at"}`, written seconds after session start. Cheap
  watch target for "new session appeared".
- Record shape: `{"timestamp","type","payload"}`. Types:
  - `session_meta` (line 1): `payload.session_id`, `payload.cwd`, `originator`
    (`codex_vscode` for extension sessions — same files as terminal CLI), `cli_version`.
  - `turn_context`: per-turn `turn_id`, `model`, `cwd`.
  - `event_msg` subtypes: `task_started` (turn begin), `task_complete`
    (`last_agent_message` — reliable turn-end), `user_message`, `agent_message`,
    `token_count` (`info.total_token_usage` / `last_token_usage`).
  - `response_item` subtypes: `message` (role + content array), `reasoning` (opaque),
    `function_call` (`name` e.g. `shell_command`, `arguments` JSON string, `call_id`),
    `function_call_output` (`call_id`, `output`).
- `codex exec --ephemeral` writes no session file.

### Launching

- Interactive: `codex "first prompt"` (positional), `-C <dir>` sets working root.
- Resume: `codex resume <SESSION_ID> [PROMPT]`, `codex resume --last`.
- **No `--session-id` equivalent** — the id is minted by Codex (UUIDv7). Discover it
  via the `SessionStart` hook payload (preferred), `session_index.jsonl`, or newest
  rollout file.
- Binary on this machine: NOT on PATH. Locations:
  `~/.codex/.sandbox-bin/codex.exe` and
  `%USERPROFILE%\.vscode\extensions\openai.chatgpt-*\bin\windows-x86_64\codex.exe`.
  Add a `pixel-agents.codexPath` VS Code setting; resolution order: setting → `codex`
  on PATH → `~/.codex/.sandbox-bin/codex.exe` → newest `openai.chatgpt-*` extension bin.

---

## 2. Files to create

```
server/src/providers/hook/codex/
  codex.ts                 codexProvider: HookProvider (normalizeHookEvent, sets, fallback)
  codexHookInstaller.ts    atomic install/uninstall in ~/.codex/hooks.json
  constants.ts             event names, paths, script name
  hooks/codex-hook.ts      hook script (CJS+shebang, bundled to dist/hooks/codex-hook.js)
server/__tests__/codex.test.ts
server/__tests__/codexHookInstaller.test.ts
```

Wire into `server/src/providers/index.ts` (registry) and `esbuild.js` (bundle
`hooks/codex-hook.ts` → `dist/hooks/codex-hook.js`, same pattern as claude-hook).

## 3. normalizeHookEvent mapping

| Codex event                      | AgentEvent.kind                 | Notes                                                                                                                                                        |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SessionStart`                   | `sessionStart`                  | map `source`; carry `transcriptPath`, `cwd`                                                                                                                  |
| `UserPromptSubmit`               | `promptSubmit`                  | carry prompt text — **verify the payload field name with a real dump** (`prompt` expected but unconfirmed); prompt-prefix "(Name)" correlation depends on it |
| `PreToolUse`                     | `toolStart`                     | `toolId = tool_use_id`, `toolName = tool_name`                                                                                                               |
| `PostToolUse`                    | `toolEnd`                       |                                                                                                                                                              |
| `Stop`                           | `turnEnd`                       |                                                                                                                                                              |
| `PermissionRequest`              | `permissionRequest`             |                                                                                                                                                              |
| `SubagentStart` / `SubagentStop` | `subagentStart` / `subagentEnd` |                                                                                                                                                              |
| `PreCompact` / `PostCompact`     | drop (return null)              |                                                                                                                                                              |

No SessionEnd: external Codex agents are cleaned up by the existing stale check
(30 s scanner) instead of a sessionEnd event. Document this in codex.ts.

`formatToolStatus`: map `shell_command` → the command string (truncated),
`apply_patch` → "Editing <file>", web/search tools by name. Typing-vs-reading
animation sets: `shell_command`/`apply_patch` type; searches/reads read.

## 4. Hook script + installer

`hooks/codex-hook.ts`: copy claude-hook.ts, POST to `/api/hooks/codex`. Keep the
server.json discovery, bearer token, 2 s timeout, debug logging.

Installer: manage a named entry in `~/.codex/hooks.json` for all 10 events (or the
zero-drag subset — see below), each command wrapped exactly like the Claude zero-drag
wrapper (`cmd /c if exist <server.json> node <script>` on win32) so a closed panel
costs nothing. Atomic write (tmp + rename). `areHooksInstalled` checks by script-path
marker, mirroring claudeHookInstaller. Respect `hookEventMode`: zero-drag subset =
`SessionStart`, `Stop`, `PermissionRequest`, `UserPromptSubmit` (+ tail the rollout
for tool animations, exactly like the Claude zero-drag mode); `full` = all events.

## 5. File fallback (heuristic mode)

The Claude provider's per-project dirs don't map to Codex's date dirs:

- `getAllSessionRoots()`: return today's and yesterday's
  `~/.codex/sessions/YYYY/MM/DD` dirs.
- `sessionFilePattern`: `rollout-*.jsonl`.
- Project filter: read line 1 (`session_meta.payload.cwd`) and compare via the
  normalized path key helper (`pathKeys.ts`) against tracked workspace dirs.
- `parseTranscriptLine`: `function_call` → toolStart, `function_call_output` →
  toolEnd, `event_msg/task_complete` → turnEnd, `event_msg/token_count` → token
  usage, `event_msg/user_message` → prompt activity.
- Session id: from filename or `session_meta`.

## 6. Multi-provider plumbing (the real work)

Today the runtime is single-provider (`new AgentRuntime(store, claudeProvider)`).
Close these gaps:

1. `HookEventHandler` (or its construction) must dispatch by the `:providerId` route
   param on `POST /api/hooks/:providerId` — registry lookup instead of one bound
   provider. `handleEvent` already receives `providerId`; it currently ignores it.
2. `ServerAgentState` already has a provider reference field — set it at
   creation/adoption; scanners iterate every registered provider's session roots.
3. Hook install/uninstall (settings toggle + activation): loop over registered
   providers; a provider whose CLI isn't installed (binary/config dir missing)
   silently skips with one log line.
4. Launch: add `pixel-agents.launchCli` setting: `claude` (default) | `codex` |
   `ask` (quick-pick per launch). Codex launches use **terminal mode**
   (`buildLaunchCommand`; there is no editor-tab command for Codex we control).
   Keep the "(Name)" first-prompt template — correlation via the Codex
   `UserPromptSubmit` hook works identically. Fallback correlation: watch
   `session_index.jsonl` for a new id during the pending-spawn window and record it
   as the spawn candidate (the pending-spawn candidate path already exists).
5. AsyncAPI: if the webview needs a per-launch CLI choice later, `launchAgent` gains
   an optional `cli` field (contract change + regen). NOT needed for v1 with the
   setting-based approach — avoid touching the contract in v1.

## 7. Testing

- Unit: `codex.test.ts` mirrors `claude.test.ts` (one normalize case per event,
  fallback line parsing against the real record shapes in section 1);
  installer test mirrors `claudeHookInstaller.test.ts`.
- E2E: add a `mock-codex` fixture only if cheap; otherwise defer, unit coverage
  is acceptable for v1.
- **Warning:** `npm run test:server` writes to the real `~/.pixel-agents/` (known
  upstream bug, documented in CLAUDE.md). Back it up first; close the panel.

## 8. Acceptance

1. With hooks approved in Codex (`/hooks`), opening `codex` in a workspace terminal
   makes a character appear, animate on tool use, and go idle on `Stop`.
2. `+ Agent` with `launchCli: codex` opens a terminal running codex with the
   "(Name)" prompt; the character binds (no duplicate character, no zombie
   placeholder) — the pending-spawn rules from the 1.4.1 fix apply unchanged.
3. Claude sessions keep working untouched; both provider types coexist in one office.
4. Panel closed → codex sessions run with zero hook cost (the `if exist` guard).
5. Uninstalling hooks removes only pixel-agents entries from `~/.codex/hooks.json`.
