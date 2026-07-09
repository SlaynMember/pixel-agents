import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { AgentRuntime } from '../../server/src/agentRuntime.js';
import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import type { AgentState } from '../../server/src/types.js';
import { getProjectDirPath, launchNewTerminal } from './agentManager.js';
import { assignAgentName } from './agentNames.js';
import { CLAUDE_CODE_EDITOR_OPEN_COMMAND, TAB_SPAWN_FIRST_PROMPT_TEMPLATE } from './constants.js';

/**
 * Launch a new agent as a Claude Code editor tab instead of a terminal.
 *
 * The real session id isn't known at launch time (editor.open doesn't return
 * one), so a named placeholder character appears immediately and the session
 * is bound later via AgentRuntime's pending-spawn registry: primarily by
 * matching the "(Name)" prefix on the first UserPromptSubmit, with a
 * same-folder SessionStart candidate as a timeout fallback. See
 * AgentRuntime.addPendingSpawn / bindPendingSpawn.
 */
export async function launchNewTab(
  store: AgentStateStore,
  runtime: AgentRuntime,
  folderPath?: string,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const cwd = folderPath || folders?.[0]?.uri.fsPath || os.homedir();
  const isMultiRoot = !!(folders && folders.length > 1);
  const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
  const projectDir = getProjectDirPath(cwd);

  const name = assignAgentName(store);
  const id = store.nextAgentId.current++;

  const agent: AgentState = {
    id,
    sessionId: '',
    terminalRef: undefined,
    isExternal: false,
    isTab: true,
    projectDir,
    jsonlFile: '',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    folderName,
    name,
    hookDelivered: false,
    inputTokens: 0,
    outputTokens: 0,
  };

  // Fires the named `agentCreated` broadcast -> character spawns with matrix effect.
  store.set(id, agent);
  runtime.activeAgentId.current = id;
  store.persist();
  runtime.startProjectScan(projectDir);

  // Synthetic overlay so the placeholder reads busy while the tab opens.
  // Cleared by agentToolsClear at bind (bindPendingSpawn) or on removal.
  store.broadcast({
    type: 'agentToolStart',
    id,
    toolId: 'pending-open',
    status: 'Opening Claude tab...',
    toolName: '',
  });

  runtime.addPendingSpawn(id, name, projectDir, cwd);

  const firstPrompt = TAB_SPAWN_FIRST_PROMPT_TEMPLATE.replaceAll('{name}', name);

  try {
    await vscode.commands.executeCommand(
      CLAUDE_CODE_EDITOR_OPEN_COMMAND,
      undefined,
      firstPrompt,
      vscode.ViewColumn.Active,
    );
  } catch (e) {
    console.error(
      `[Pixel Agents] Tab launch: ${CLAUDE_CODE_EDITOR_OPEN_COMMAND} failed, falling back to terminal: ${e}`,
    );
    runtime.pendingSpawns.removeByAgentId(id);
    runtime.removeAgent(id);
    void vscode.window.showWarningMessage(
      'Pixel Agents: Could not open a Claude Code tab (is the Claude Code extension installed?). Falling back to terminal mode.',
    );
    await launchNewTerminal(
      store.nextAgentId,
      store.nextTerminalIndex,
      store,
      runtime.activeAgentId,
      runtime.knownJsonlFiles,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
      runtime.jsonlPollTimers,
      runtime.projectScanTimer,
      () => store.persist(),
      folderPath,
    );
  }
}
