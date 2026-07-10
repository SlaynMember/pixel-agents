import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { LAYOUT_FILE_DIR } from '../../server/src/constants.js';
import { INTERN_FIRST_PROMPT_PREFIX } from './constants.js';

const CHORES_FILE_NAME = 'chores.json';

interface Chore {
  id: string;
  title: string;
  status: string;
  prompt: string;
  dispatchedAt?: string;
}

interface ChoresFile {
  version: number;
  updated?: string;
  chores: Chore[];
  [key: string]: unknown;
}

function choresFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CHORES_FILE_NAME);
}

/**
 * "Dispatch Intern": quick-pick open chores from ~/.pixel-agents/chores.json and
 * launch each as a named agent tab. Chores are one-shot: dispatched entries are
 * marked in the file so the next refresh (any Claude session can rewrite the
 * list) starts clean.
 */
export async function dispatchIntern(
  launchTab: (promptTemplate: string) => Promise<void>,
): Promise<void> {
  const filePath = choresFilePath();
  let parsed: ChoresFile;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ChoresFile;
  } catch {
    void vscode.window.showInformationMessage(
      `Pixel Agents: no chore list at ${filePath}. Ask Claude to write one (see the file's _readme convention).`,
    );
    return;
  }

  const open = (parsed.chores ?? []).filter((c) => c.status === 'open' && c.prompt);
  if (open.length === 0) {
    void vscode.window.showInformationMessage(
      'Pixel Agents: no open chores. Ask Claude to refresh ~/.pixel-agents/chores.json.',
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    open.map((c) => ({
      label: c.title,
      detail: c.prompt.length > 120 ? `${c.prompt.slice(0, 120)}...` : c.prompt,
      chore: c,
    })),
    {
      title: 'Dispatch interns — pick chores',
      placeHolder: 'Each picked chore launches its own intern tab',
      canPickMany: true,
    },
  );
  if (!picked || picked.length === 0) return;

  for (const item of picked) {
    await launchTab(INTERN_FIRST_PROMPT_PREFIX + item.chore.prompt);
    item.chore.status = 'dispatched';
    item.chore.dispatchedAt = new Date().toISOString().slice(0, 10);
  }

  try {
    fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  } catch (e) {
    console.error(`[Pixel Agents] Intern dispatch: failed to update chores file: ${e}`);
  }
}
