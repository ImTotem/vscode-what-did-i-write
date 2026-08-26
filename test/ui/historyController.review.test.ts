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
    ) { this.fsPath = fsPath ?? path; }
    public static from(parts: { scheme: string; authority?: string; path?: string }): Uri {
      return new Uri(parts.scheme, parts.authority ?? '', parts.path ?? '');
    }
    public static file(path: string): Uri { return new Uri('file', '', path, '', '', path); }
    public toString(): string { return `${this.scheme}://${this.authority}${this.path}`; }
  }
  class Position { public constructor(public readonly line: number, public readonly character: number) {} }
  class Range { public constructor(public readonly start: Position, public readonly end: Position) {} }
  class Selection extends Range {}
  const showQuickPick = vi.fn(async (_items: unknown) => undefined as unknown);
  const executeCommand = vi.fn(async (..._args: unknown[]) => undefined);
  const stat = vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: 1 }));
  const activeTextEditor = {
    document: { uri: Uri.file('/repo/source.ts'), lineCount: 10 },
    selection: { active: new Position(0, 0) } as unknown,
    revealRange: vi.fn()
  };
  return { Uri, Position, Range, Selection, showQuickPick, executeCommand, stat, activeTextEditor };
});

vi.mock('vscode', () => ({
  Uri: mocks.Uri,
  Position: mocks.Position,
  Range: mocks.Range,
  Selection: mocks.Selection,
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  commands: { executeCommand: mocks.executeCommand },
  window: { activeTextEditor: mocks.activeTextEditor, showQuickPick: mocks.showQuickPick },
  workspace: { fs: { stat: mocks.stat } }
}));

import type { CommitSummary } from '../../src/core/model.js';
import type { RepositoryRegistry } from '../../src/extension/repositoryRegistry.js';
import { GitContentProvider, parseRevisionUri, revisionUri } from '../../src/ui/gitContentProvider.js';
import { HistoryController, type HistoryQuickPickItem } from '../../src/ui/historyController.js';

const ROOT = join(process.cwd(), 'review repo');
const commit: CommitSummary = {
  hash: 'abcdef1234567890', authorName: 'Me', authorEmail: 'me@example.com',
  authoredAt: 1_700_000_000, subject: 'Line commit'
};

afterEach(() => {
  mocks.showQuickPick.mockReset();
  mocks.executeCommand.mockReset();
  mocks.stat.mockReset().mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 1 });
  mocks.activeTextEditor.document = { uri: mocks.Uri.file(join(ROOT, 'source.ts')), lineCount: 10 };
  mocks.activeTextEditor.selection = { active: new mocks.Position(0, 0) };
  mocks.activeTextEditor.revealRange.mockReset();
});

describe('reviewed working line history', () => {
  it('keeps Current changes for an untracked line without querying HEAD history', async () => {
    const repository = fakeRepository([{ status: '?', path: 'untracked.ts' }]);
    const controller = new HistoryController(registry(repository, 'untracked.ts'));

    await controller.showLineHistory(join(ROOT, 'untracked.ts'), 0);

    expect(repository.getLineHistory).not.toHaveBeenCalled();
    const items = mocks.showQuickPick.mock.calls[0]?.[0] as unknown as HistoryQuickPickItem[];
    expect(items.map(({ itemType }) => itemType)).toEqual(['working']);
  });

  it('maps a staged rename destination to its original HEAD path', async () => {
    const repository = fakeRepository([
      { status: 'R.', path: 'renamed.ts', originalPath: 'original.ts' }
    ]);
    const controller = new HistoryController(registry(repository, 'renamed.ts'));

    await controller.showLineHistory(join(ROOT, 'renamed.ts'), 2);

    expect(repository.getLineHistory).toHaveBeenCalledWith('original.ts', 3);
    const items = mocks.showQuickPick.mock.calls[0]?.[0] as unknown as HistoryQuickPickItem[];
    expect(items.map(({ itemType }) => itemType)).toEqual(['working', 'commit']);
  });

  it('queries HEAD history with the mapped coordinate after working insertions or deletions', async () => {
    const repository = fakeRepository([{ status: '.M', path: 'source.ts' }]);
    repository.mapWorkingLineToHead.mockResolvedValueOnce(4);
    const controller = new HistoryController(registry(repository, 'source.ts'));

    await controller.showLineHistory(join(ROOT, 'source.ts'), 2);

    expect(repository.mapWorkingLineToHead).toHaveBeenCalledWith('source.ts', 3);
    expect(repository.getLineHistory).toHaveBeenCalledWith('source.ts', 4);
    const items = mocks.showQuickPick.mock.calls[0]?.[0] as unknown as HistoryQuickPickItem[];
    expect(items.map(({ itemType }) => itemType)).toEqual(['working', 'commit']);
  });

  it('shows only Current changes when the selected working line has no HEAD origin', async () => {
    const repository = fakeRepository([{ status: '.M', path: 'source.ts' }]);
    repository.mapWorkingLineToHead.mockResolvedValueOnce(undefined);
    const controller = new HistoryController(registry(repository, 'source.ts'));

    await controller.showLineHistory(join(ROOT, 'source.ts'), 1);

    expect(repository.mapWorkingLineToHead).toHaveBeenCalledWith('source.ts', 2);
    expect(repository.getLineHistory).not.toHaveBeenCalled();
    const items = mocks.showQuickPick.mock.calls[0]?.[0] as unknown as HistoryQuickPickItem[];
    expect(items.map(({ itemType }) => itemType)).toEqual(['working']);
  });

  it('uses the recreated workspace file after a staged deletion plus untracked record', async () => {
    const repository = fakeRepository([
      { status: 'D.', path: 'source.ts' },
      { status: '?', path: 'source.ts' }
    ]);
    mocks.showQuickPick.mockImplementationOnce(async (items: unknown) =>
      (items as HistoryQuickPickItem[]).find(({ itemType }) => itemType === 'working')
    );
    const controller = new HistoryController(registry(repository, 'source.ts'));

    await controller.showFileHistory(join(ROOT, 'source.ts'));

    const diffCall = mocks.executeCommand.mock.calls[0];
    expect(diffCall?.[0]).toBe('vscode.diff');
    expect((diffCall?.[2] as vscode.Uri).scheme).toBe('file');
    expect((diffCall?.[2] as vscode.Uri).fsPath).toBe(join(ROOT, 'source.ts'));
  });

  it('reveals a clamped line only after the intended diff editor becomes active', async () => {
    const repository = fakeRepository([]);
    mocks.showQuickPick.mockImplementationOnce(async (items: unknown) => (items as HistoryQuickPickItem[])[0]);
    mocks.executeCommand.mockImplementationOnce(async (_command, _before, after: unknown) => {
      mocks.activeTextEditor.document = { uri: after as typeof mocks.activeTextEditor.document.uri, lineCount: 2 };
    });
    const controller = new HistoryController(registry(repository, 'source.ts'));

    await controller.showLineHistory(join(ROOT, 'source.ts'), 8);

    expect((mocks.activeTextEditor.selection as { active?: unknown; start?: { line: number } }).start?.line).toBe(1);
    expect(mocks.activeTextEditor.revealRange).toHaveBeenCalledOnce();

    mocks.activeTextEditor.revealRange.mockReset();
    mocks.showQuickPick.mockImplementationOnce(async (items: unknown) => (items as HistoryQuickPickItem[])[0]);
    mocks.executeCommand.mockImplementationOnce(async () => {
      mocks.activeTextEditor.document = { uri: mocks.Uri.file('/unrelated.ts'), lineCount: 20 };
    });
    await controller.showLineHistory(join(ROOT, 'source.ts'), 1);
    expect(mocks.activeTextEditor.revealRange).not.toHaveBeenCalled();
  });
});

describe('reviewed provider errors', () => {
  it('reports Git content failures and still rejects the document load', async () => {
    const error = new Error('show failed');
    const onError = vi.fn();
    const provider = new GitContentProvider(registry({ showFile: vi.fn(async () => { throw error; }) }), onError);

    await expect(provider.provideTextDocumentContent(revisionUri(ROOT, 'abcdef1', 'source.ts')))
      .rejects.toThrow('show failed');
    expect(onError).toHaveBeenCalledWith(error, 'revision-content', 'source.ts');
  });

  it('returns empty content for an unknown repository without invoking Git', async () => {
    const repository = { showFile: vi.fn() };
    const provider = new GitContentProvider(registry(repository, 'source.ts', '/other-root'));
    const uri = revisionUri(ROOT, 'abcdef1', 'source.ts');

    expect(parseRevisionUri(uri)).toEqual({ root: ROOT, revision: 'abcdef1', path: 'source.ts' });
    expect(await provider.provideTextDocumentContent(uri)).toBe('');
    expect(repository.showFile).not.toHaveBeenCalled();
  });
});

function fakeRepository(changes: readonly { status: string; path: string; originalPath?: string }[]) {
  return {
    getFileHistoryEntries: vi.fn(async () => [{ commit, path: 'source.ts', parentPath: 'source.ts' }]),
    getFileHistory: vi.fn(async () => [commit]),
    getLineHistory: vi.fn(async () => [commit]),
    mapWorkingLineToHead: vi.fn(async (_path: string, line: number): Promise<number | undefined> => line),
    getWorkingChanges: vi.fn(async () => [...changes]),
    showFile: vi.fn(async () => Buffer.from('content'))
  };
}

function registry(repository: Record<string, unknown>, relativePath = 'source.ts', root = ROOT) {
  const entry = {
    root,
    state: 'ready' as const,
    repository,
    analyzer: { getSnapshot: () => ({
      root, head: 'f'.repeat(40), identity: { name: 'Me', email: 'me@example.com' },
      files: [{ relativePath, kind: 'modified', exists: true, working: true, binary: false, ranges: [], history: [commit] }],
      scanning: false, generatedAt: 1
    }) }
  };
  return {
    repositories: [entry],
    findByUri: vi.fn((uri: { fsPath: string }) => uri.fsPath.startsWith(root) ? entry : undefined)
  } as unknown as RepositoryRegistry;
}
