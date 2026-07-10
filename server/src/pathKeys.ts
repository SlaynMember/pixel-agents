import * as path from 'path';

/**
 * Windows paths arrive at comparison sites with mixed casing depending on
 * their source: `fs.readdirSync`-derived paths carry disk casing (e.g.
 * `C--Users-willp-Local-Sites`), while Claude Code hook payloads carry
 * cwd-derived casing (e.g. `c--Users-willp-Local-Sites`, lowercase drive
 * letter). Raw string equality between the two never matches on Windows.
 * Every cross-source path comparison (scanner vs. hook, agent.jsonlFile vs.
 * scanned file, Set membership) must go through this key so casing never
 * causes a false "these are different files" result.
 */
export function normalizeFsPathKey(p: string): string {
  // Never call path.resolve('') -- it resolves to process.cwd(), which would
  // make two genuinely-empty paths (e.g. an unbound tab spawn's jsonlFile)
  // spuriously "match" the server's working directory.
  if (!p) return '';
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when both paths are non-empty and resolve to the same normalized key. */
export function sameFsPath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return normalizeFsPathKey(a) === normalizeFsPathKey(b);
}
