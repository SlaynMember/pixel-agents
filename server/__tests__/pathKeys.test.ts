import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { normalizeFsPathKey, sameFsPath } from '../src/pathKeys.js';

/**
 * normalizeFsPathKey/sameFsPath are pure functions over the process's native
 * `path` module (no fs/os I/O), so these tests are homedir-safe. The win32
 * casing behavior is exercised via `runIf(process.platform === 'win32')`
 * rather than stubbing process.platform: pathKeys.ts calls the ACTUAL native
 * `path.resolve`, which is fixed to the real OS regardless of any
 * process.platform stub, so a stubbed test would assert against the wrong
 * path-formatting rules on non-Windows CI legs.
 */
describe('normalizeFsPathKey', () => {
  it('returns empty string for falsy input (never resolves to cwd)', () => {
    expect(normalizeFsPathKey('')).toBe('');
  });

  it('is idempotent', () => {
    const once = normalizeFsPathKey('some/relative/path');
    expect(normalizeFsPathKey(once)).toBe(once);
  });

  it.runIf(process.platform === 'win32')(
    'lowercases resolved paths on win32 so differently-cased drive letters match',
    () => {
      const expected = path.resolve('C:\\Users\\Will\\Project').toLowerCase();
      expect(normalizeFsPathKey('C:\\Users\\Will\\Project')).toBe(expected);
      expect(normalizeFsPathKey('c:\\users\\WILL\\project')).toBe(expected);
    },
  );

  it.runIf(process.platform !== 'win32')('preserves case on non-win32 platforms', () => {
    expect(normalizeFsPathKey('/Users/Will')).toBe(path.resolve('/Users/Will'));
    expect(normalizeFsPathKey('/Users/Will')).not.toBe(normalizeFsPathKey('/users/will'));
  });
});

describe('sameFsPath', () => {
  it('is false when either side is empty', () => {
    expect(sameFsPath('', '/a')).toBe(false);
    expect(sameFsPath('/a', '')).toBe(false);
    expect(sameFsPath('', '')).toBe(false);
  });

  it('is true for identical paths', () => {
    expect(sameFsPath('/a/b', '/a/b')).toBe(true);
  });

  it.runIf(process.platform === 'win32')('matches differently-cased paths on win32', () => {
    expect(sameFsPath('C:\\Users\\Will', 'c:\\users\\will')).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('does not match differently-cased paths elsewhere', () => {
    expect(sameFsPath('/Users/Will', '/users/will')).toBe(false);
  });
});
