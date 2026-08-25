import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  class Uri {
    public readonly fsPath: string;

    public constructor(
      public readonly scheme: string,
      public readonly authority: string,
      public readonly path: string,
      public readonly query = '',
      public readonly fragment = '',
      fsPath?: string
    ) {
      this.fsPath = fsPath ?? path;
    }

    public static from(parts: { scheme: string; authority?: string; path?: string }): Uri {
      return new Uri(parts.scheme, parts.authority ?? '', parts.path ?? '');
    }

    public static file(path: string): Uri {
      return new Uri('file', '', path, '', '', path);
    }

    public toString(): string {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
  }

  class Position {
    public constructor(public readonly line: number, public readonly character: number) {}
  }

  class Range {
    public constructor(public readonly start: Position, public readonly end: Position) {}
  }

  class Selection extends Range {}

  const executeCommand = vi.fn(async (..._args: unknown[]) => undefined);
  const showQuickPick = vi.fn(async (_items: unknown) => undefined as unknown);
  const activeTextEditor = {
    document: { uri: Uri.from({ scheme: 'my-code-git', path: '/revision' }) },
    selection: undefined as Selection | undefined,
    revealRange: vi.fn()
  };

  return { Uri, Position, Range, Selection, executeCommand, showQuickPick, activeTextEditor };
});

vi.mock('vscode', () => ({
  Uri: mocks.Uri,
  Position: mocks.Position,
  Range: mocks.Range,
  Selection: mocks.Selection,
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  commands: { executeCommand: mocks.executeCommand },
  window: {
    activeTextEditor: mocks.activeTextEditor,
    showQuickPick: mocks.showQuickPick
  },
  workspace: { fs: undefined },
}));

import type { CommitSummary, GitIdentity } from '../../src/core/model.js';
import type { RepositoryRegistry } from '../../src/extension/repositoryRegistry.js';
import {
  GitContentProvider,
  parseRevisionUri,
  revisionUri
} from '../../src/ui/gitContentProvider.js';
import {
  HistoryController,
  commitQuickPickItems,
  type HistoryQuickPickItem
} from '../../src/ui/historyController.js';

const ROOT = join(process.cwd(), 'history repo');
const identity: GitIdentity = { name: 'Me', email: 'me@example.com' };
const mine = commit('bbbbbbb22222222', 'Me', 'ME@example.com', 1_700_000_000, 'My change');
const other = commit('aaaaaaa11111111', 'Other', 'other@example.com', 1_700_000_100, 'Other change');

afterEach(() => {
  mocks.executeCommand.mockReset();
  mocks.showQuickPick.mockReset();
  mocks.activeTextEditor.revealRange.mockReset();
  mocks.activeTextEditor.selection = undefined;
});

describe('Git revision documents', () => {
  it('round-trips special paths through base64url without exposing them in the authority', () => {
    const uri = revisionUri('C:\\repo', 'abc1234^', 'src/a b#한글.ts');

    expect(uri.scheme).toBe('my-code-git');
    expect(uri.authority).toBe('');
    expect(uri.path).not.toContain('src/a b#한글.ts');
    expect(parseRevisionUri(uri)).toEqual({
      root: 'C:\\repo', revision: 'abc1234^', path: 'src/a b#한글.ts'
    });
  });

  it('rejects malformed payloads and unsafe revisions before repository access', async () => {
    const showFile = vi.fn(async () => Buffer.from('must not run'));
    const provider = new GitContentProvider(registryWith({ showFile }));
    const malformed = mocks.Uri.from({ scheme: 'my-code-git', path: '/not_base64!' }) as unknown as vscode.Uri;
    const unsafePayload = Buffer.from(JSON.stringify({
      root: ROOT, revision: 'HEAD;echo owned', path: 'src/a.ts'
    })).toString('base64url');
    const unsafe = mocks.Uri.from({ scheme: 'my-code-git', path: `/${unsafePayload}` }) as unknown as vscode.Uri;

    await expect(provider.provideTextDocumentContent(malformed)).rejects.toThrow(/revision URI/i);
    await expect(provider.provideTextDocumentContent(unsafe)).rejects.toThrow(/revision/i);
    expect(showFile).not.toHaveBeenCalled();
  });

  it('decodes Git bytes with replacement and renders absent revision sides as empty', async () => {
    const showFile = vi.fn()
      .mockResolvedValueOnce(Buffer.from([0x66, 0x6f, 0x80]))
      .mockResolvedValueOnce(undefined);
    const provider = new GitContentProvider(registryWith({ showFile }));
    const uri = revisionUri(ROOT, 'abcdef1', 'src/a b.ts');

    expect(await provider.provideTextDocumentContent(uri)).toBe('fo�');
    expect(await provider.provideTextDocumentContent(uri)).toBe('');
    expect(showFile).toHaveBeenNthCalledWith(1, 'abcdef1', 'src/a b.ts');
  });
});

describe('history QuickPick rows', () => {
  it('filters by normalized identity, sorts newest first, and includes path/date/hash details', () => {
    const items = commitQuickPickItems([other, mine], identity, 'src/a b.ts', 1_700_086_400_000);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      itemType: 'commit',
      label: 'My change',
      description: '1 day ago · bbbbbbb',
      detail: expect.stringContaining('Me <ME@example.com>')
    });
    expect(items[0]?.detail).toContain('src/a b.ts');
  });
});

describe('HistoryController', () => {
  it('uses the active file, offers current changes first, and opens a rename-aware commit diff', async () => {
    const repository = {
      getFileHistoryEntries: vi.fn(async () => [{
        commit: mine, path: 'src/new name.ts', parentPath: 'src/old name.ts'
      }]),
      getFileHistory: vi.fn(async () => [mine]),
      getLineHistory: vi.fn(async () => [mine]),
      getWorkingChanges: vi.fn(async () => [{ status: 'R.', path: 'src/new name.ts', originalPath: 'src/old name.ts' }]),
      showFile: vi.fn()
    };
    const registry = registryWith(repository, 'src/new name.ts');
    mocks.activeTextEditor.document = {
      uri: mocks.Uri.file(join(ROOT, 'src/new name.ts'))
    } as unknown as vscode.TextDocument;
    mocks.showQuickPick.mockImplementationOnce(async (items: unknown) =>
      (items as HistoryQuickPickItem[]).find(({ itemType }) => itemType === 'commit')
    );
    const controller = new HistoryController(registry, () => 1_700_086_400_000);

    await controller.showFileHistory();

    const shown = mocks.showQuickPick.mock.calls[0]?.[0] as unknown as HistoryQuickPickItem[];
    expect(shown.map(({ itemType }) => itemType)).toEqual(['working', 'commit']);
    expect(repository.getFileHistoryEntries).toHaveBeenCalledWith('src/old name.ts');
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expectRevision('bbbbbbb22222222^', 'src/old name.ts'),
      expectRevision('bbbbbbb22222222', 'src/new name.ts'),
      'src/old name.ts → src/new name.ts — My change (bbbbbbb)',
      { preview: true }
    );
  });

  it('opens deleted and root commit sides as empty-capable revision documents', async () => {
    const controller = new HistoryController(registryWith({ showFile: vi.fn() }));

    await controller.openCommitDiff({
      root: ROOT, relativePath: 'deleted [x].ts', commit: mine,
      path: 'deleted [x].ts', parentPath: 'deleted [x].ts'
    });
    await controller.openCommitDiff({
      root: ROOT, relativePath: 'root file.ts', commit: { ...mine, subject: 'Root add' },
      path: 'root file.ts', parentPath: undefined
    });

    expect(mocks.executeCommand).toHaveBeenNthCalledWith(
      1, 'vscode.diff',
      expectRevision('bbbbbbb22222222^', 'deleted [x].ts'),
      expectRevision('bbbbbbb22222222', 'deleted [x].ts'),
      'deleted [x].ts — My change (bbbbbbb)',
      { preview: true }
    );
    expect(mocks.executeCommand).toHaveBeenNthCalledWith(
      2, 'vscode.diff',
      expectRevision('bbbbbbb22222222^', 'root file.ts'),
      expectRevision('bbbbbbb22222222', 'root file.ts'),
      'root file.ts — Root add (bbbbbbb)',
      { preview: true }
    );
  });

  it('converts the active zero-based line to Git one-based input and reveals it in the chosen diff', async () => {
    const repository = {
      getLineHistory: vi.fn(async () => [other, mine]),
      getWorkingChanges: vi.fn(async () => []),
      showFile: vi.fn()
    };
    const registry = registryWith(repository, 'src/line.ts');
    mocks.activeTextEditor.document = {
      uri: mocks.Uri.file(join(ROOT, 'src/line.ts'))
    } as unknown as vscode.TextDocument;
    mocks.activeTextEditor.selection = {
      active: new mocks.Position(4, 9)
    } as unknown as vscode.Selection;
    mocks.showQuickPick.mockImplementationOnce(async (items: unknown) => (items as HistoryQuickPickItem[])[0]);
    const controller = new HistoryController(registry, () => 1_700_086_400_000);
    mocks.executeCommand.mockImplementationOnce(async (_command, _before, after) => {
      mocks.activeTextEditor.document = {
        uri: after as InstanceType<typeof mocks.Uri>,
        lineCount: 5
      } as unknown as vscode.TextDocument;
    });

    await controller.showLineHistory();

    expect(repository.getLineHistory).toHaveBeenCalledWith('src/line.ts', 5);
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.diff', expect.anything(), expect.anything(),
      'src/line.ts:5 — My change (bbbbbbb)', { preview: true }
    );
    expect(mocks.activeTextEditor.selection).toEqual({
      start: { line: 4, character: 0 }, end: { line: 4, character: 0 }
    });
    expect(mocks.activeTextEditor.revealRange).toHaveBeenCalledWith(
      expect.objectContaining({ start: expect.objectContaining({ line: 4 }) }), 2
    );
  });
});

function commit(
  hash: string,
  authorName: string,
  authorEmail: string,
  authoredAt: number,
  subject: string
): CommitSummary {
  return { hash, authorName, authorEmail, authoredAt, subject };
}

function registryWith(repository: Record<string, unknown>, relativePath?: string) {
  const entry = {
    root: ROOT,
    state: 'ready' as const,
    repository,
    analyzer: {
      getSnapshot: () => ({
        root: ROOT,
        head: 'f'.repeat(40),
        identity,
        files: relativePath === undefined ? [] : [{
          relativePath, kind: 'modified', exists: true, working: true,
          binary: false, ranges: [], history: [mine]
        }],
        scanning: false,
        generatedAt: 1
      })
    }
  };
  return {
    repositories: [entry],
    findByUri: vi.fn((uri: { fsPath: string }) => uri.fsPath.startsWith(ROOT) ? entry : undefined)
  } as unknown as RepositoryRegistry;
}

function expectRevision(revision: string, path: string): unknown {
  return {
    asymmetricMatch(actual: vscode.Uri): boolean {
      expect(parseRevisionUri(actual)).toEqual({ root: ROOT, revision, path });
      return true;
    }
  };
}
