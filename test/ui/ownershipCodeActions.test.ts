import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  class CodeAction {
    public command: { command: string; title: string; arguments?: unknown[] } | undefined;
    public isPreferred = false;
    public constructor(public readonly title: string, public readonly kind: unknown) {}
  }
  return { CodeAction, visualsEnabled: { value: true } };
});

vi.mock('vscode', () => ({
  CodeAction: mocks.CodeAction,
  CodeActionKind: { QuickFix: { value: 'quickfix' } },
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: boolean) => mocks.visualsEnabled.value ?? fallback
    })
  }
}));

import type { FileRecord, RepositorySnapshot } from '../../src/core/model.js';
import type { RepositoryRegistry } from '../../src/extension/repositoryRegistry.js';
import { OwnershipCodeActionProvider } from '../../src/ui/ownershipCodeActions.js';

const ROOT = join(process.cwd(), 'repo');
const SOURCE = join(ROOT, 'src', 'current.ts');

describe('OwnershipCodeActionProvider', () => {
  it('offers line and file history actions only for an authored line', () => {
    const provider = new OwnershipCodeActionProvider(registryFor(record([
      { start: 1, endExclusive: 3, uncommitted: false }
    ])));
    const document = documentFor(SOURCE);

    const actions = provider.provideCodeActions(document, rangeAt(1));

    expect(actions).toEqual([
      expect.objectContaining({
        title: 'Line history',
        isPreferred: true,
        command: {
          command: 'myCode.focusLineHistory',
          title: 'Line history',
          arguments: [SOURCE, 1]
        }
      }),
      expect.objectContaining({
        title: 'File history',
        command: {
          command: 'myCode.focusFileHistory',
          title: 'File history',
          arguments: [SOURCE]
        }
      })
    ]);
    expect(provider.provideCodeActions(document, rangeAt(0))).toEqual([]);

    mocks.visualsEnabled.value = false;
    expect(provider.provideCodeActions(document, rangeAt(1))).toEqual([]);
    mocks.visualsEnabled.value = true;
  });
});


function documentFor(path: string): vscode.TextDocument {
  return { uri: { scheme: 'file', fsPath: path, toString: () => path } } as vscode.TextDocument;
}

function rangeAt(line: number): vscode.Range {
  return { start: { line, character: 0 }, end: { line, character: 0 } } as vscode.Range;
}

function record(ranges: FileRecord['ranges']): FileRecord {
  return { relativePath: 'src/current.ts', kind: 'modified', exists: true, working: false, binary: false, ranges, history: [] };
}

function registryFor(file: FileRecord): RepositoryRegistry {
  const snapshot: RepositorySnapshot = {
    root: ROOT,
    head: 'head',
    identity: { name: 'Me', email: 'me@example.com' },
    files: [file],
    scanning: false,
    generatedAt: 1
  };
  const entry = { root: ROOT, state: 'ready', analyzer: { getSnapshot: () => snapshot } };
  return { findByUri: () => entry } as unknown as RepositoryRegistry;
}
