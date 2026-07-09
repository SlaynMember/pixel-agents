import * as path from 'path';

/** A tab-mode agent placeholder waiting for its real Claude Code session id to
 *  bind (via a matching UserPromptSubmit prompt, or the SessionStart candidate
 *  fallback at timeout). */
export interface PendingSpawn {
  agentId: number;
  /** Assigned display name; also the "(Name)" prompt-prefix correlation key. */
  name: string;
  projectDir: string;
  cwd: string;
  createdAt: number;
  /** Recorded by the SessionStart fallback matcher; only consumed at timeout,
   *  and only if UserPromptSubmit never bound this spawn first. */
  candidateSessionId?: string;
  candidateTranscriptPath?: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks pending tab-mode spawns between "editor.open() was called" and "the
 * real session id is known". Session ids aren't available at launch time (the
 * Claude Code tab command doesn't return one), so correlation happens after
 * the fact via the first prompt's "(Name)" prefix (primary) or a same-folder
 * SessionStart seen while the spawn is pending (fallback, bound only at
 * timeout). Extracted from AgentRuntime to keep spawn-matching logic testable
 * in isolation from the rest of the runtime.
 */
export class PendingSpawnRegistry {
  private spawns = new Map<number, PendingSpawn>();

  add(spawn: PendingSpawn): void {
    this.spawns.set(spawn.agentId, spawn);
  }

  /** Clears the timeout and removes the record. Returns the removed spawn, if any. */
  removeByAgentId(agentId: number): PendingSpawn | undefined {
    const spawn = this.spawns.get(agentId);
    if (spawn) {
      clearTimeout(spawn.timer);
      this.spawns.delete(agentId);
    }
    return spawn;
  }

  /** Find the pending spawn whose "(Name)" prefix matches the submitted prompt. */
  findByPromptPrefix(prompt: string): PendingSpawn | undefined {
    for (const spawn of this.spawns.values()) {
      if (prompt.startsWith(`(${spawn.name})`)) {
        return spawn;
      }
    }
    return undefined;
  }

  /**
   * Find the sole pending spawn in a given project directory (case-insensitive,
   * path.resolve-normalized). Returns undefined when zero or more than one
   * spawn matches, so the SessionStart fallback never binds an ambiguous
   * candidate (two simultaneous spawns in the same folder are left to the
   * prompt-prefix matcher, which is unambiguous by construction).
   */
  findSoleByProjectDir(dir: string): PendingSpawn | undefined {
    const resolved = path.resolve(dir).toLowerCase();
    const matches = [...this.spawns.values()].filter(
      (s) => path.resolve(s.projectDir).toLowerCase() === resolved,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  dispose(): void {
    for (const spawn of this.spawns.values()) {
      clearTimeout(spawn.timer);
    }
    this.spawns.clear();
  }
}
