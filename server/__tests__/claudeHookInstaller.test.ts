import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_HOOK_EVENTS_FULL,
  CLAUDE_HOOK_EVENTS_MINIMAL,
} from '../src/providers/hook/claude/constants.js';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { areHooksInstalled, installHooks, uninstallHooks, copyHookScript } =
  await import('../src/providers/hook/claude/claudeHookInstaller.js');

function readSettings(): Record<string, unknown> {
  const p = path.join(tmpBase, '.claude', 'settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('claudeHookInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-test-'));
    fs.mkdirSync(path.join(tmpBase, '.claude'), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. installHooks adds entries
  it('installHooks adds entries to settings.json', () => {
    installHooks();
    const settings = readSettings();
    expect(settings.hooks).toBeTruthy();
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks['Notification']).toHaveLength(1);
    expect(hooks['Stop']).toHaveLength(1);
    expect(hooks['PermissionRequest']).toHaveLength(1);
  });

  // 2. installHooks is idempotent
  it('installHooks is idempotent', () => {
    installHooks();
    installHooks();
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(hooks['Notification']).toHaveLength(1);
    expect(hooks['Stop']).toHaveLength(1);
    expect(hooks['PermissionRequest']).toHaveLength(1);
  });

  // 3. areHooksInstalled returns true after install
  it('areHooksInstalled returns true after install', () => {
    installHooks();
    expect(areHooksInstalled()).toBe(true);
  });

  // 4. areHooksInstalled returns false before install
  it('areHooksInstalled returns false before install', () => {
    expect(areHooksInstalled()).toBe(false);
  });

  // 5. uninstallHooks removes entries
  it('uninstallHooks removes entries', () => {
    installHooks();
    expect(areHooksInstalled()).toBe(true);
    uninstallHooks();
    expect(areHooksInstalled()).toBe(false);
  });

  // 6. uninstallHooks cleans empty hooks object
  it('uninstallHooks cleans empty hooks object', () => {
    installHooks();
    uninstallHooks();
    const settings = readSettings();
    expect(settings.hooks).toBeUndefined();
  });

  // 7. Handles missing settings.json
  it('handles missing settings.json gracefully', () => {
    expect(() => areHooksInstalled()).not.toThrow();
    expect(areHooksInstalled()).toBe(false);
  });

  // 8. Handles malformed settings.json
  it('handles malformed settings.json gracefully', () => {
    fs.writeFileSync(path.join(tmpBase, '.claude', 'settings.json'), 'not json!!!');
    expect(() => areHooksInstalled()).not.toThrow();
    expect(areHooksInstalled()).toBe(false);
  });

  // 9. copyHookScript copies file
  it('copyHookScript copies to ~/.pixel-agents/hooks/', () => {
    // Create a mock extension path with dist/hooks/claude-hook.js
    const mockExtPath = path.join(tmpBase, 'mock-ext');
    const hookSrc = path.join(mockExtPath, 'dist', 'hooks');
    fs.mkdirSync(hookSrc, { recursive: true });
    fs.writeFileSync(path.join(hookSrc, 'claude-hook.js'), '// mock hook script');

    copyHookScript(mockExtPath);

    const dst = path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-hook.js');
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.readFileSync(dst, 'utf-8')).toBe('// mock hook script');
  });

  // 10. copyHookScript sets executable permissions (non-Windows)
  it('copyHookScript sets executable permissions', () => {
    if (process.platform === 'win32') return; // chmod not meaningful on Windows

    const mockExtPath = path.join(tmpBase, 'mock-ext');
    const hookSrc = path.join(mockExtPath, 'dist', 'hooks');
    fs.mkdirSync(hookSrc, { recursive: true });
    fs.writeFileSync(path.join(hookSrc, 'claude-hook.js'), '// mock');

    copyHookScript(mockExtPath);

    const dst = path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-hook.js');
    const stat = fs.statSync(dst);
    // Check owner execute bit
    expect(stat.mode & 0o100).toBeTruthy();
  });

  // 11. Command is wrapped with a server.json existence check (WI-7)
  it('wraps the hook command with a server.json existence check', () => {
    installHooks();
    const hooks = readSettings().hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    const command = hooks['Stop'][0].hooks[0].command;
    expect(command).toContain('claude-hook.js');
    expect(command).toContain('server.json');
    // sh-style on every platform: Claude Code runs hook commands under a
    // POSIX shell (Git Bash on Windows), where cmd.exe syntax silently
    // drops the event. Script path must use forward slashes only.
    expect(command.startsWith('[ -f "$HOME/.pixel-agents/server.json" ]')).toBe(true);
    expect(command.endsWith('|| true')).toBe(true);
    expect(command).not.toContain('cmd /c');
    expect(command).not.toContain('\\');
  });

  // 12. installHooks(MINIMAL) installs only the minimal event set
  it('installHooks(MINIMAL) installs only the minimal event set', () => {
    installHooks(CLAUDE_HOOK_EVENTS_MINIMAL);
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    for (const event of CLAUDE_HOOK_EVENTS_MINIMAL) {
      expect(hooks[event]).toHaveLength(1);
    }
    const fullOnlyEvents = CLAUDE_HOOK_EVENTS_FULL.filter(
      (e) => !(CLAUDE_HOOK_EVENTS_MINIMAL as readonly string[]).includes(e),
    );
    expect(fullOnlyEvents).toHaveLength(8);
    for (const event of fullOnlyEvents) {
      expect(hooks[event]).toBeUndefined();
    }
  });

  // 13. full -> minimal strips the stale per-tool-call event blocks
  it('switching from full to minimal removes the stale tool-event blocks', () => {
    installHooks(CLAUDE_HOOK_EVENTS_FULL);
    installHooks(CLAUDE_HOOK_EVENTS_MINIMAL);
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(hooks['PreToolUse']).toBeUndefined();
    expect(hooks['PostToolUse']).toBeUndefined();
    expect(hooks['SubagentStart']).toBeUndefined();
    expect(hooks['TaskCreated']).toBeUndefined();
    for (const event of CLAUDE_HOOK_EVENTS_MINIMAL) {
      expect(hooks[event]).toHaveLength(1);
    }
  });

  // 14. minimal -> full re-installs the tool-event blocks
  it('switching from minimal to full re-installs the tool-event blocks', () => {
    installHooks(CLAUDE_HOOK_EVENTS_MINIMAL);
    installHooks(CLAUDE_HOOK_EVENTS_FULL);
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    for (const event of CLAUDE_HOOK_EVENTS_FULL) {
      expect(hooks[event]).toHaveLength(1);
    }
  });

  // 15. areHooksInstalled checks only the passed event set
  it('areHooksInstalled(events) checks only the passed event set', () => {
    installHooks(CLAUDE_HOOK_EVENTS_MINIMAL);
    expect(areHooksInstalled(CLAUDE_HOOK_EVENTS_MINIMAL)).toBe(true);
    expect(areHooksInstalled(CLAUDE_HOOK_EVENTS_FULL)).toBe(false);
  });

  // 16. installHooks self-cleans a stale/legacy marker entry outside the requested set
  it('installHooks strips stale marker entries from events outside the requested set', () => {
    installHooks(CLAUDE_HOOK_EVENTS_FULL);
    installHooks(CLAUDE_HOOK_EVENTS_MINIMAL);

    // Simulate a stale full-only entry left behind by an old install (e.g. the
    // pablodelucca extension, or a prior script path) that this run never wrote.
    const settingsPath = path.join(tmpBase, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    settings.hooks['PreToolUse'] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'node "/old/path/claude-hook.js"', timeout: 5 }],
      },
    ];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    installHooks(CLAUDE_HOOK_EVENTS_MINIMAL);
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(hooks['PreToolUse']).toBeUndefined();
  });
});
