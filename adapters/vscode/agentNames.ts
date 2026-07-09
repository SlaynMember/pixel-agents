import * as vscode from 'vscode';

import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { CONFIG_KEY_AGENT_NAMES } from './constants.js';

const DEFAULT_AGENT_NAMES = ['Paul', 'Dot', 'Mango', 'Pixel', 'Beans', 'Juno', 'Ivy', 'Clyde'];

/** Strips a trailing " 2", " 3", ... suffix added once the base roster is exhausted. */
function stripNumericSuffix(name: string): string {
  return name.replace(/ \d+$/, '');
}

/**
 * Picks the next display name for a newly created agent. Reads the
 * `pixel-agents.agentNames` roster (falls back to the built-in default),
 * then returns the first name — in declared order — not already used by a
 * live agent. Once every name in the roster is taken, picks the least-used
 * name and appends a numeric suffix (" 2", " 3", ...) to keep it unique.
 */
export function assignAgentName(store: AgentStateStore): string {
  const configured = vscode.workspace
    .getConfiguration()
    .get<string[]>(CONFIG_KEY_AGENT_NAMES, DEFAULT_AGENT_NAMES);
  const names = configured && configured.length > 0 ? configured : DEFAULT_AGENT_NAMES;

  const usageCounts = new Map<string, number>();
  for (const agent of store.values()) {
    if (!agent.name) continue;
    const base = stripNumericSuffix(agent.name);
    usageCounts.set(base, (usageCounts.get(base) ?? 0) + 1);
  }

  for (const name of names) {
    if (!usageCounts.has(name)) {
      return name;
    }
  }

  let leastUsedName = names[0];
  let leastUsedCount = usageCounts.get(leastUsedName) ?? 0;
  for (const name of names) {
    const count = usageCounts.get(name) ?? 0;
    if (count < leastUsedCount) {
      leastUsedName = name;
      leastUsedCount = count;
    }
  }

  return `${leastUsedName} ${leastUsedCount + 1}`;
}
