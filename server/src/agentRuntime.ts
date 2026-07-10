/**
 * AgentRuntime: shared agent lifecycle core for VS Code and standalone modes.
 *
 * Owns all infrastructure that both PixelAgentsViewProvider (VS Code) and the
 * standalone CLI need: timer Maps, file watchers, HookEventHandler, DismissalTracker,
 * session scanning, and agent removal. Adapters (VS Code, CLI) create an instance
 * and register platform-specific lifecycle callbacks.
 *
 * This is the single source of truth for agent lifecycle wiring. No duplication.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { PENDING_SPAWN_CANDIDATE_BIND_DELAY_MS, PENDING_SPAWN_TIMEOUT_MS } from './constants.js';
import { DismissalTracker } from './dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  ensureProjectScan,
  isTrackedProjectDir,
  readNewLines,
  reassignAgentToFile,
  scanForTeammateFiles,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider as setFileWatcherHookProvider,
  setTeammateRemovalCallback,
  setTeamProvider,
  startExternalSessionScanning,
  startFileWatching,
  startStaleExternalAgentCheck,
} from './fileWatcher.js';
import type { HookEvent } from './hookEventHandler.js';
import { HookEventHandler } from './hookEventHandler.js';
import { normalizeFsPathKey, sameFsPath } from './pathKeys.js';
import type { PendingSpawn } from './pendingSpawnRegistry.js';
import { PendingSpawnRegistry } from './pendingSpawnRegistry.js';
import { SessionRouter } from './sessionRouter.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import { setHookProvider } from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Callbacks that adapters register for platform-specific behavior. */
export interface RuntimeLifecycleCallbacks {
  /** Called after an agent is removed. Adapters use this to dismiss JSONL files, etc. */
  onAgentRemoved?: (agentId: number, agent: AgentState) => void;
  /** Called when a teammate is removed. */
  onTeammateRemoved?: (teammateId: number, agent: AgentState, source: string) => void;
}

export class AgentRuntime {
  // Per-agent timer Maps (shared by all fileWatcher/hookEventHandler operations)
  readonly fileWatchers = new Map<number, fs.FSWatcher>();
  readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

  // Scanning state
  readonly knownJsonlFiles = new Set<string>();
  readonly projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
  readonly activeAgentId = { current: null as number | null };
  private externalScanTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Configuration refs (mutable, shared with scanners)
  readonly watchAllSessions = { current: false };
  readonly hooksEnabled = { current: true };

  // Dependencies
  readonly dismissalTracker = new DismissalTracker();
  readonly pendingSpawns = new PendingSpawnRegistry();
  private hookEventHandler: HookEventHandler;
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};

  constructor(
    private readonly store: AgentStateStore,
    provider: HookProvider,
  ) {
    // Wire module-level dependencies
    setDismissalTracker(this.dismissalTracker);
    setHookProvider(provider);
    setFileWatcherHookProvider(provider);
    if (provider.team) {
      setTeamProvider(provider.team);
    }
    setAgentRemovalCallback((id) => this.removeAgent(id));
    setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));

    this.hookEventHandler = new HookEventHandler(
      store,
      this.waitingTimers,
      this.permissionTimers,
      provider,
      new SessionRouter(),
      this.watchAllSessions,
    );

    // Wire hook lifecycle callbacks to shared agent operations
    this.hookEventHandler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd) => {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        if (!isTrackedProjectDir(projectDir) && !this.watchAllSessions.current) {
          return;
        }
        adoptExternalSessionFromHook(
          sessionId,
          transcriptPath,
          cwd,
          this.knownJsonlFiles,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          (agent) => this.registerAgent(agent.sessionId, agent.id),
          (pd, sid, tp) => this.offerCandidateToPendingSpawn(pd, sid, tp),
        );
      },
      onSessionClear: (agentId, newSessionId, newTranscriptPath) => {
        if (newTranscriptPath) {
          this.knownJsonlFiles.add(normalizeFsPathKey(newTranscriptPath));
          reassignAgentToFile(
            agentId,
            newTranscriptPath,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
          );
        }
        const agent = this.store.get(agentId);
        if (agent) {
          this.unregisterAgent(agent.sessionId);
          agent.sessionId = newSessionId;
          this.registerAgent(agent.sessionId, agent.id);
        }
      },
      onSessionResume: (transcriptPath) => {
        this.dismissalTracker.clearDismissal(transcriptPath);
        this.dismissalTracker.clearSeededMtime(transcriptPath);
        this.knownJsonlFiles.delete(normalizeFsPathKey(transcriptPath));
      },
      onTeammateDetected: (parentAgentId, sessionId, _agentType) => {
        const parentAgent = this.store.get(parentAgentId);
        if (!parentAgent) return;
        scanForTeammateFiles(
          parentAgent.projectDir,
          sessionId,
          parentAgentId,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          // Don't register inline teammates: they share the lead's sessionId
          // and registering them would overwrite the lead in the session router.
          undefined,
        );
      },
      onTeammateRemoved: (teammateAgentId) => {
        this.removeTeammate(teammateAgentId, 'hooks');
      },
      onSessionEnd: (agentId) => {
        const agent = this.store.get(agentId);
        if (!agent) return;
        this.dismissalTracker.clearSeededMtime(agent.jsonlFile);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        if (agent.isTeamLead) {
          this.removeTeammates(agentId);
        }
        if (agent.isExternal) {
          this.unregisterAgent(agent.sessionId);
          this.removeAgent(agentId);
        }
      },
      onPromptSubmit: (sessionId, prompt) => {
        // hookEventHandler now calls this for EVERY UserPromptSubmit (known
        // agents included, see the promptSubmit branch there) so the prefix
        // match can self-heal a usurped session. Skip the scan entirely on
        // the common empty-registry path.
        if (this.pendingSpawns.isEmpty()) return false;
        const spawn = this.pendingSpawns.findByPromptPrefix(prompt);
        if (!spawn) return false;
        return this.bindPendingSpawn(spawn, sessionId);
      },
      onSessionStartCandidate: (sessionId, transcriptPath, cwd) => {
        const dir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        if (!dir) return;
        const spawn = this.pendingSpawns.findSoleByProjectDir(dir);
        if (!spawn || spawn.candidateSessionId) return;
        this.recordCandidate(spawn, sessionId, transcriptPath);
      },
    });
  }

  // ── Pending tab-mode spawns (prompt-named launch correlation) ──

  /** Register a tab-mode placeholder awaiting its real session id. Arms a
   *  timeout: if a SessionStart candidate was recorded in the meantime, bind
   *  to it (fallback matcher wins at timeout); otherwise despawn the
   *  placeholder (covers "user closed the tab without typing"). */
  addPendingSpawn(agentId: number, name: string, projectDir: string, cwd: string): void {
    const timer = setTimeout(() => {
      const spawn = this.pendingSpawns.removeByAgentId(agentId);
      if (!spawn) return;
      if (spawn.candidateSessionId) {
        this.bindPendingSpawn(spawn, spawn.candidateSessionId, spawn.candidateTranscriptPath);
      } else {
        this.removeAgent(agentId);
      }
    }, PENDING_SPAWN_TIMEOUT_MS);
    this.pendingSpawns.add({ agentId, name, projectDir, cwd, createdAt: Date.now(), timer });
  }

  /**
   * Bind a pending spawn's placeholder agent to its real session. Dedupes
   * against a Watch-All global-scanner race (same session id or resolved
   * jsonl already tracked by another agent), starts file watching from the
   * beginning of the file (it's seconds old -- replay is correct), and clears
   * the placeholder's synthetic "Opening Claude tab..." overlay.
   */
  bindPendingSpawn(spawn: PendingSpawn, sessionId: string, transcriptPath?: string): boolean {
    this.pendingSpawns.removeByAgentId(spawn.agentId);
    const agent = this.store.get(spawn.agentId);
    if (!agent) return false;

    const jsonlFile = transcriptPath || path.join(spawn.projectDir, `${sessionId}.jsonl`);
    for (const [otherId, otherAgent] of this.store) {
      if (otherId === spawn.agentId) continue;
      if (
        (otherAgent.sessionId && otherAgent.sessionId === sessionId) ||
        sameFsPath(otherAgent.jsonlFile, jsonlFile)
      ) {
        // Self-heal for a Watch-All usurper that registered this session
        // before we got here (see promptSubmit reordering in
        // hookEventHandler.ts). removeAgent() alone doesn't unregister the
        // session mapping -- every other removal call site pairs it with
        // unregisterAgent explicitly, so do the same here rather than rely
        // on the registerAgent() overwrite below to paper over it.
        if (otherAgent.sessionId) this.unregisterAgent(otherAgent.sessionId);
        this.removeAgent(otherId);
      }
    }

    agent.sessionId = sessionId;
    agent.jsonlFile = jsonlFile;
    agent.hookDelivered = true;
    agent.fileOffset = 0;
    this.knownJsonlFiles.add(normalizeFsPathKey(jsonlFile));

    this.registerAgent(sessionId, spawn.agentId);
    startFileWatching(
      spawn.agentId,
      jsonlFile,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
    );
    readNewLines(spawn.agentId, this.store, this.waitingTimers, this.permissionTimers);

    this.store.broadcast({ type: 'agentToolsClear', id: spawn.agentId });
    this.store.persist();
    return true;
  }

  /**
   * Give a pending spawn first claim on a session a scanner is about to adopt
   * as a brand-new external agent. Called by the external/global scanners and
   * the hook-driven adopter BEFORE they create an agent, so a "+ Agent" tab
   * placeholder always wins its own session instead of losing it to a
   * same-tick Watch-All scan (see class doc / Background in the fix spec).
   *
   * Returns true when the caller should skip adoption entirely: either this
   * call just claimed the sole pending spawn in projectDir, or that spawn was
   * already claimed by this exact sessionId. Returns false when there's no
   * sole pending spawn for the dir, or it's already claimed by a DIFFERENT
   * session -- normal adoption proceeds.
   */
  offerCandidateToPendingSpawn(
    projectDir: string,
    sessionId: string,
    transcriptPath?: string,
  ): boolean {
    const spawn = this.pendingSpawns.findSoleByProjectDir(projectDir);
    if (!spawn) return false;
    if (spawn.candidateSessionId === sessionId) return true;
    if (spawn.candidateSessionId) return false;
    this.recordCandidate(spawn, sessionId, transcriptPath);
    return true;
  }

  /**
   * Record a candidate session on a pending spawn and arm the early-bind
   * timer. Shared by offerCandidateToPendingSpawn (pre-adoption scanner
   * claim) and the onSessionStartCandidate lifecycle callback (SessionStart
   * fallback record) so both paths get the same early-bind behavior instead
   * of only binding at the full PENDING_SPAWN_TIMEOUT_MS timeout.
   */
  private recordCandidate(spawn: PendingSpawn, sessionId: string, transcriptPath?: string): void {
    spawn.candidateSessionId = sessionId;
    spawn.candidateTranscriptPath = transcriptPath;
    if (spawn.earlyBindTimer) clearTimeout(spawn.earlyBindTimer);
    spawn.earlyBindTimer = setTimeout(() => {
      const stillPending = this.pendingSpawns.removeByAgentId(spawn.agentId);
      if (!stillPending?.candidateSessionId) return;
      this.bindPendingSpawn(
        stillPending,
        stillPending.candidateSessionId,
        stillPending.candidateTranscriptPath,
      );
    }, PENDING_SPAWN_CANDIDATE_BIND_DELAY_MS);
  }

  /** Register adapter-specific lifecycle callbacks. */
  setLifecycleCallbacks(callbacks: RuntimeLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  // ── Hook event routing ──

  /** Route an incoming hook event to the appropriate agent. */
  handleHookEvent(providerId: string, event: Record<string, unknown>): void {
    this.hookEventHandler.handleEvent(providerId, event as HookEvent);
  }

  /** Register an agent with the hook event handler for session->agent mapping. */
  registerAgent(sessionId: string, agentId: number): void {
    this.hookEventHandler.registerAgent(sessionId, agentId);
  }

  /** Unregister an agent from the hook event handler. */
  unregisterAgent(sessionId: string): void {
    this.hookEventHandler.unregisterAgent(sessionId);
  }

  // ── Agent removal (shared cleanup) ──

  /** Remove an agent: stop watchers, cancel timers, delete from store. */
  removeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;

    // Stop JSONL poll timer
    const jpTimer = this.jsonlPollTimers.get(id);
    if (jpTimer) {
      clearInterval(jpTimer);
    }
    this.jsonlPollTimers.delete(id);

    // Stop file watching
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    const pt = this.pollingTimers.get(id);
    if (pt) {
      clearInterval(pt);
    }
    this.pollingTimers.delete(id);

    // Cancel timers
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);

    // Notify adapter before deleting from store
    this.lifecycleCallbacks.onAgentRemoved?.(id, agent);

    // Remove from store (fires agentRemoved event) and persist
    this.store.delete(id);
    this.store.persist();
  }

  /** Remove a single teammate agent. */
  removeTeammate(teammateId: number, source: string): void {
    const agent = this.store.get(teammateId);
    if (!agent) return;
    console.log(`[Pixel Agents] Removing teammate ${teammateId} (source: ${source})`);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    this.unregisterAgent(agent.sessionId);
    this.lifecycleCallbacks.onTeammateRemoved?.(teammateId, agent, source);
    this.removeAgent(teammateId);
  }

  /** Remove all teammates of a lead agent. */
  removeTeammates(leadId: number): void {
    const teammates: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.leadAgentId === leadId) {
        teammates.push(id);
      }
    }
    for (const id of teammates) {
      const agent = this.store.get(id);
      if (agent) {
        console.log(`[Pixel Agents] Removing teammate ${id} (lead ${leadId} closed)`);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        this.unregisterAgent(agent.sessionId);
        this.removeAgent(id);
      }
    }
  }

  // ── Scanning ──

  /** Start project-level scanning for a directory. */
  startProjectScan(projectDir: string, onAgentCreated?: (agent: AgentState) => void): void {
    ensureProjectScan(
      projectDir,
      this.knownJsonlFiles,
      this.projectScanTimer,
      this.activeAgentId,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      onAgentCreated ?? ((agent) => this.registerAgent(agent.sessionId, agent.id)),
      this.hooksEnabled,
    );
  }

  /** Start external session scanning (detects sessions from other terminals). */
  startExternalScanning(projectDir: string): void {
    if (this.externalScanTimer) return;

    this.externalScanTimer = startExternalSessionScanning(
      projectDir,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      () => this.store.persist(),
      this.watchAllSessions,
      this.hooksEnabled,
      (pd, sid, tp) => this.offerCandidateToPendingSpawn(pd, sid, tp),
    );
  }

  /** Start stale external agent check (removes agents whose JSONL files are deleted). */
  startStaleCheck(): void {
    if (this.staleCheckTimer) return;

    this.staleCheckTimer = startStaleExternalAgentCheck(
      this.store,
      this.knownJsonlFiles,
      this.hooksEnabled,
    );
  }

  // ── Restore persisted external agents (standalone) ──

  /**
   * Re-create external agents from the adapter's persistence on startup.
   * Only external agents are restorable here (no terminal to rebind).
   * VS Code uses its own restoreAgents() in agentManager.ts to also handle
   * terminal agents via vscode.window.terminals.
   */
  restoreExternalAgents(): void {
    const adapter = this.store.getAdapter();
    if (!adapter) return;
    const persisted = adapter.loadAgents();
    if (persisted.length === 0) return;

    let maxId = 0;

    for (const p of persisted) {
      if (!p.isExternal) continue;
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
      if (this.store.has(p.id)) {
        this.knownJsonlFiles.add(normalizeFsPathKey(p.jsonlFile));
        if (p.id > maxId) maxId = p.id;
        continue;
      }

      const agent: AgentState = {
        id: p.id,
        sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
        terminalRef: undefined,
        isExternal: true,
        projectDir: p.projectDir,
        jsonlFile: p.jsonlFile,
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
        folderName: p.folderName,
        hookDelivered: false,
        inputTokens: 0,
        outputTokens: 0,
        teamName: p.teamName,
        agentName: p.agentName,
        isTeamLead: p.isTeamLead,
        leadAgentId: p.leadAgentId,
        teamUsesTmux: p.teamUsesTmux,
      };

      this.store.set(p.id, agent);
      this.knownJsonlFiles.add(normalizeFsPathKey(p.jsonlFile));

      try {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
        );
      } catch {
        /* ignore stat errors on restore */
      }

      this.registerAgent(agent.sessionId, agent.id);

      if (p.id > maxId) maxId = p.id;
      console.log(
        `[Pixel Agents] Restored external agent ${p.id} -> ${path.basename(p.jsonlFile)}`,
      );
    }

    if (maxId >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxId + 1;
    }

    this.store.persist();
  }

  // ── Cleanup ──

  /** Clean up all scanners, timers, and agents. Called on shutdown. */
  dispose(): void {
    this.hookEventHandler.dispose();
    this.pendingSpawns.dispose();

    if (this.projectScanTimer.current) {
      clearInterval(this.projectScanTimer.current);
      this.projectScanTimer.current = null;
    }
    if (this.externalScanTimer) {
      clearInterval(this.externalScanTimer);
      this.externalScanTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }

    for (const id of [...this.store.keys()]) {
      this.removeAgent(id);
    }
  }
}
