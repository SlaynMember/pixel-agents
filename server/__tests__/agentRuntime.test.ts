import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

/**
 * AgentRuntime is constructed with a bare AgentStateStore (no adapter set),
 * so store.persist() is a no-op and nothing here touches fs/os.homedir --
 * see AgentStateStore.persist(). claudeProvider is imported elsewhere in this
 * suite (hookEventHandler.test.ts) without touching the filesystem at import
 * time; its fs-touching methods (getSessionDirs, installHooks, etc.) are
 * never called here.
 */
describe('AgentRuntime.offerCandidateToPendingSpawn', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;

  beforeEach(() => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
  });

  afterEach(() => {
    // Clears both the spawn timeout and the early-bind timer for any spawn
    // left pending by a test.
    runtime.dispose();
  });

  it('returns false when there is no pending spawn in the project dir', () => {
    expect(runtime.offerCandidateToPendingSpawn('/proj', 'sess-1')).toBe(false);
  });

  it('claims the sole pending spawn in the dir and returns true', () => {
    runtime.addPendingSpawn(1, 'Paul', '/proj', '/proj');

    expect(runtime.offerCandidateToPendingSpawn('/proj', 'sess-1', '/proj/sess-1.jsonl')).toBe(
      true,
    );
  });

  it('returns true again for a repeat offer of the SAME sessionId (idempotent claim)', () => {
    runtime.addPendingSpawn(1, 'Paul', '/proj', '/proj');
    runtime.offerCandidateToPendingSpawn('/proj', 'sess-1', '/proj/sess-1.jsonl');

    expect(runtime.offerCandidateToPendingSpawn('/proj', 'sess-1', '/proj/sess-1.jsonl')).toBe(
      true,
    );
  });

  it('returns false for a DIFFERENT sessionId once the spawn already has a candidate', () => {
    runtime.addPendingSpawn(1, 'Paul', '/proj', '/proj');
    runtime.offerCandidateToPendingSpawn('/proj', 'sess-1', '/proj/sess-1.jsonl');

    // A second, different session in the same dir must not steal the claim --
    // normal adoption proceeds for it instead.
    expect(runtime.offerCandidateToPendingSpawn('/proj', 'sess-2', '/proj/sess-2.jsonl')).toBe(
      false,
    );
  });

  // Windows-only: normalizeFsPathKey only lowercases when process.platform is
  // actually win32 (it calls the real, OS-fixed path.resolve -- see
  // pathKeys.test.ts for why this can't be simulated by stubbing the platform
  // on a non-Windows CI leg).
  it.runIf(process.platform === 'win32')(
    'is case-insensitive on the project dir (Windows readdir vs. cwd casing)',
    () => {
      runtime.addPendingSpawn(1, 'Paul', 'C:\\Users\\Will\\proj', 'C:\\Users\\Will\\proj');

      // Scanner-derived dir carries disk casing; this must still resolve to
      // the sole spawn above (see pathKeys.ts / Background in the fix spec).
      expect(
        runtime.offerCandidateToPendingSpawn(
          'c:\\users\\will\\proj',
          'sess-1',
          'c:\\users\\will\\proj\\sess-1.jsonl',
        ),
      ).toBe(true);
    },
  );

  it('does not claim when two pending spawns share the same project dir (ambiguous)', () => {
    runtime.addPendingSpawn(1, 'Paul', '/proj', '/proj');
    runtime.addPendingSpawn(2, 'Dot', '/proj', '/proj');

    // findSoleByProjectDir returns undefined for >1 match -- left to the
    // unambiguous prompt-prefix matcher instead.
    expect(runtime.offerCandidateToPendingSpawn('/proj', 'sess-1', '/proj/sess-1.jsonl')).toBe(
      false,
    );
  });
});
