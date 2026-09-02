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
  const showQuickPick = vi.fn(async (_items: unknown, _options?: vscode.QuickPickOptions) => undefined as unknown);
  const visibleTextEditors: vscode.TextEditor[] = [];
  const activeTextEditor = {
    document: { uri: Uri.from({ scheme: 'my-code-git', path: '/revision' }) },
    selection: undefined as Selection | undefined,
    viewColumn: 2,
    revealRange: vi.fn()
  };

  const language = { value: 'en' };
  const translate = vi.fn((message: string) => message);
  return { Uri, Position, Range, Selection, executeCommand, showQuickPick, activeTextEditor, visibleTextEditors, language, translate };
});

vi.mock('vscode', () => ({
  Uri: mocks.Uri,
  Position: mocks.Position,
  Range: mocks.Range,
  Selection: mocks.Selection,
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  ViewColumn: { One: 1, Beside: -2 },
  commands: { executeCommand: mocks.executeCommand },
  window: {
    activeTextEditor: mocks.activeTextEditor,
    visibleTextEditors: mocks.visibleTextEditors,
    showQuickPick: mocks.showQuickPick
  },
  workspace: { fs: undefined },
  env: { get language() { return mocks.language.value; } },
  l10n: { t: mocks.translate }
}));

import type { CommitSummary, FileRecord, GitIdentity } from '../../src/core/model.js';
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
  mocks.visibleTextEditors.splice(0);
  mocks.activeTextEditor.document.uri = mocks.Uri.from({ scheme: 'my-code-git', path: '/revision' });
  mocks.activeTextEditor.viewColumn = 2;
  mocks.language.value = 'en';
  mocks.translate.mockImplementation((message: string) => message);
});

describe('localized history labels', () => {
  it('formats relative commit times using the VS Code display language', () => {
    mocks.language.value = 'ko';

    const [item] = commitQuickPickItems(
      [mine],
      identity,
      'src/time.h',
      mine.authoredAt * 1_000 + 120_000
    );

    expect(item?.description).toContain('2분 전');
  });
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

describe('history timeline model', () => {
  it('merges selected files into one deduplicated newest-first timeline with line stats', async () => {
    const newest = commit('ddddddd44444444', 'Me', 'me@example.com', 1_700_000_300, 'Newest');
    const shared = commit('ccccccc33333333', 'Me', 'me@example.com', 1_700_000_200, 'Shared refactor');
    const oldest = commit('bbbbbbb22222222', 'Me', 'me@example.com', 1_700_000_100, 'Oldest');
    const files: FileRecord[] = [
      { relativePath: 'src/a.ts', kind: 'modified', exists: true, working: false, binary: false,
        ranges: [{ start: 0, endExclusive: 3, uncommitted: false }], history: [newest, shared] },
      { relativePath: 'src/b.ts', kind: 'modified', exists: true, working: false, binary: false,
        ranges: [{ start: 4, endExclusive: 6, uncommitted: false }], history: [shared, oldest] }
    ];
    const statsByTarget = new Map([
      [newest.hash, { added: 3, modified: 1, deleted: 0, paths: ['src/a.ts'] }],
      [shared.hash, { added: 1, modified: 4, deleted: 2, paths: ['src/a.ts', 'src/b.ts'] }],
      [oldest.hash, { added: 2, modified: 0, deleted: 0, paths: ['src/b.ts'] }]
    ]);
    const getDiffStats = vi.fn(async (_base: string, target: string | undefined) =>
      statsByTarget.get(target ?? '') ?? { added: 0, modified: 0, deleted: 0, paths: [] });
    const getCommitDiffStats = vi.fn(async () => statsByTarget);
    const repository = {
      getWorkingChanges: vi.fn(async () => []),
      getUserIndex: vi.fn(async () => ({
        commits: [newest, shared, oldest],
        entries: [
          { commit: newest, changes: [{ status: 'M', path: 'src/a.ts' }] },
          { commit: shared, changes: [{ status: 'M', path: 'src/a.ts' }, { status: 'M', path: 'src/b.ts' }] },
          { commit: oldest, changes: [{ status: 'A', path: 'src/b.ts' }] }
        ]
      })),
      getDiffStats,
      getCommitDiffStats
    };
    const controller = new HistoryController(registryWithFiles(repository, files), () => 1_700_000_400_000);
    const getSelectionTimeline = (controller as unknown as {
      getSelectionTimeline?: (selection: readonly unknown[]) => Promise<unknown>;
    }).getSelectionTimeline;

    expect(getSelectionTimeline).toBeTypeOf('function');
    const model = await getSelectionTimeline?.call(controller, files.map((file) => ({
      kind: 'file', root: ROOT, file
    }))) as {
      mode: string;
      fileCount: number;
      currentOwnedLines: number;
      selectedPaths: readonly string[];
      entries: ReadonlyArray<{ kind: string; id: string; stats?: unknown; revision?: string }>;
    } | undefined;

    expect(model).toMatchObject({
      mode: 'selection', fileCount: 2, currentOwnedLines: 5,
      selectedPaths: ['src/a.ts', 'src/b.ts']
    });
    expect(model?.entries.filter(({ kind }) => kind === 'commit')).toEqual([
      expect.objectContaining({ id: `commit:${newest.hash}`, stats: statsByTarget.get(newest.hash) }),
      expect.objectContaining({ id: `commit:${shared.hash}`, stats: statsByTarget.get(shared.hash) }),
      expect.objectContaining({ id: `commit:${oldest.hash}`, stats: statsByTarget.get(oldest.hash) })
    ]);
    expect(model?.entries.at(-1)).toMatchObject({ kind: 'original', revision: `${oldest.hash}^` });
    expect(getCommitDiffStats).toHaveBeenCalledTimes(1);
    expect(getDiffStats).not.toHaveBeenCalled();
  });

  it('keeps the existing single-file diff flow when one MY CHANGES file is selected', async () => {
    const file: FileRecord = {
      relativePath: 'src/a.ts', kind: 'modified', exists: true, working: false, binary: false,
      ranges: [{ start: 0, endExclusive: 3, uncommitted: false }], history: [mine]
    };
    const stats = { added: 1, modified: 2, deleted: 0, paths: ['src/a.ts'] };
    const repository = {
      getWorkingChanges: vi.fn(async () => []),
      getFileHistoryEntries: vi.fn(async () => [{ commit: mine, path: 'src/a.ts', parentPath: 'src/a.ts' }]),
      getUserIndex: vi.fn(async () => ({
        commits: [mine], entries: [{ commit: mine, changes: [{ status: 'M', path: 'src/a.ts' }] }]
      })),
      getDiffStats: vi.fn(async () => stats),
      getCommitDiffStats: vi.fn(async () => new Map([[mine.hash, stats]]))
    };
    const controller = new HistoryController(registryWithFiles(repository, [file]));

    const model = await controller.getSelectionTimeline([{ kind: 'file', root: ROOT, file }]);

    expect(model).toMatchObject({ mode: 'file', fileCount: 1, currentOwnedLines: 3 });
    expect(model?.entries.find(({ kind }) => kind === 'commit')).toMatchObject({ stats });
  });

  it('puts working changes first and matching name-or-email commits newest first', async () => {
    const newestByName = commit('ccccccc33333333', 'Me', 'different@example.com', 1_700_000_200, 'Newest by name');
    const repository = {
      getFileHistoryEntries: vi.fn(async () => [
        { commit: mine, path: 'src/old name.ts', parentPath: 'src/older name.ts' },
        { commit: other, path: 'src/old name.ts', parentPath: 'src/old name.ts' },
        { commit: newestByName, path: 'src/new name.ts', parentPath: 'src/old name.ts' }
      ]),
      getFileHistory: vi.fn(async () => []),
      getLineHistory: vi.fn(async () => []),
      getCommitDiffStats: vi.fn(async () => new Map([
        [newestByName.hash, { added: 2, modified: 1, deleted: 0, paths: ['src/new name.ts'] }],
        [mine.hash, { added: 0, modified: 3, deleted: 1, paths: ['src/old name.ts'] }]
      ])),
      getWorkingChanges: vi.fn(async () => [
        { status: 'R.', path: 'src/new name.ts', originalPath: 'src/old name.ts' }
      ])
    };
    const controller = new HistoryController(registryWith(repository, 'src/new name.ts'), () => 1_700_086_400_000);

    const model = await controller.getTimeline(join(ROOT, 'src/new name.ts'));

    expect(repository.getFileHistoryEntries).toHaveBeenCalledWith('src/old name.ts');
    expect(model).toMatchObject({
      root: ROOT,
      head: 'f'.repeat(40),
      sourcePath: join(ROOT, 'src/new name.ts'),
      relativePath: 'src/new name.ts',
      mode: 'file',
      fileCount: 1,
      currentOwnedLines: 0,
      selectedPaths: ['src/new name.ts', 'src/old name.ts', 'src/older name.ts'],
      currentPaths: ['src/new name.ts']
    });
    expect(model?.entries.map(({ kind }) => kind)).toEqual(['working', 'commit', 'commit', 'original']);
    expect(model?.entries.slice(1, 3).map((entry) => entry.kind === 'commit' && entry.commit.hash)).toEqual([
      newestByName.hash,
      mine.hash
    ]);
    expect(model?.entries[1]).toMatchObject({ kind: 'commit', latest: true, path: 'src/new name.ts' });
    expect(model?.entries[2]).toMatchObject({ kind: 'commit', latest: false, parentPath: 'src/older name.ts' });
    expect(model?.entries[1]).toMatchObject({
      stats: { added: 2, modified: 1, deleted: 0, paths: ['src/new name.ts'] }
    });
    expect(model?.entries[3]).toMatchObject({
      kind: 'original',
      title: 'ORIGINAL',
      detail: 'Before your first change',
      revision: mine.hash + '^',
      path: 'src/older name.ts',
      exists: true
    });
  });

  it('uses an empty ORIGINAL state when my oldest commit added the file', async () => {
    const repository = {
      getFileHistoryEntries: vi.fn(async () => [
        { commit: mine, path: 'src/created.ts', parentPath: undefined }
      ]),
      getFileHistory: vi.fn(async () => []),
      getLineHistory: vi.fn(async () => []),
      getWorkingChanges: vi.fn(async () => [])
    };
    const controller = new HistoryController(registryWith(repository, 'src/created.ts'));

    const model = await controller.getTimeline(join(ROOT, 'src/created.ts'));

    expect(model?.entries.at(-1)).toMatchObject({
      kind: 'original',
      title: 'ORIGINAL',
      detail: 'File did not exist',
      revision: mine.hash + '^',
      path: 'src/created.ts',
      exists: false
    });
  });

  it('builds line history from the mapped HEAD coordinate', async () => {
    const repository = {
      getFileHistoryEntries: vi.fn(async () => []),
      getFileHistory: vi.fn(async () => []),
      getLineHistory: vi.fn(async () => [other, mine]),
      mapWorkingLineToHead: vi.fn(async () => 7),
      getWorkingChanges: vi.fn(async () => [{ status: '.M', path: 'src/line.ts' }])
    };
    const controller = new HistoryController(registryWith(repository, 'src/line.ts'));

    const model = await controller.getTimeline(join(ROOT, 'src/line.ts'), 4);

    expect(repository.mapWorkingLineToHead).toHaveBeenCalledWith('src/line.ts', 5);
    expect(repository.getLineHistory).toHaveBeenCalledWith('src/line.ts', 7);
    expect(model).toMatchObject({ mode: 'line', line: 4, commitLine: 6 });
    expect(model?.entries.map(({ kind }) => kind)).toEqual(['working', 'commit']);
  });

  it('stops a cancelled timeline before starting the history Git stage', async () => {
    let releaseWorking: (() => void) | undefined;
    const working = new Promise<[]>(resolve => {
      releaseWorking = () => resolve([]);
    });
    const repository = {
      getFileHistoryEntries: vi.fn(async () => []),
      getFileHistory: vi.fn(async () => []),
      getLineHistory: vi.fn(async () => []),
      getWorkingChanges: vi.fn(() => working)
    };
    const controller = new HistoryController(registryWith(repository, 'src/time.h'));
    const cancellation = { isCancellationRequested: false };

    const timeline = controller.getTimeline(join(ROOT, 'src/time.h'), undefined, cancellation);
    cancellation.isCancellationRequested = true;
    releaseWorking?.();

    await expect(timeline).resolves.toBeUndefined();
    expect(repository.getFileHistoryEntries).not.toHaveBeenCalled();
  });

  it('keeps the source pinned and opens a short pinned diff in the same editor group', async () => {
    const repository = {
      getFileHistoryEntries: vi.fn(async () => [{ commit: mine, path: 'src/time.h', parentPath: 'src/time.h' }]),
      getFileHistory: vi.fn(async () => []),
      getLineHistory: vi.fn(async () => []),
      getWorkingChanges: vi.fn(async () => [])
    };
    const controller = new HistoryController(registryWith(repository, 'src/time.h'));
    const source = join(ROOT, 'src/time.h');
    const model = await controller.getTimeline(source);
    const commitEntry = model?.entries.find(({ kind }) => kind === 'commit');
    if (model === undefined || commitEntry === undefined) throw new Error('timeline model missing');
    mocks.executeCommand.mockClear();

    mocks.activeTextEditor.document.uri = mocks.Uri.file(source);
    mocks.activeTextEditor.viewColumn = 3;
    mocks.visibleTextEditors.splice(0, mocks.visibleTextEditors.length, {
      document: { uri: mocks.Uri.file(source) }, viewColumn: 2
    } as unknown as vscode.TextEditor);

    await controller.openTimelineEntry(model, 'unknown');
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    await controller.openTimelineEntry(model, commitEntry.id);

    expect(mocks.executeCommand).toHaveBeenNthCalledWith(
      1,
      'vscode.open',
      mocks.Uri.file(source),
      { preview: false, preserveFocus: true, viewColumn: 3 }
    );
    expect(mocks.executeCommand).toHaveBeenNthCalledWith(
      2,
      'vscode.diff',
      expectRevision('bbbbbbb22222222^', 'src/time.h'),
      expectRevision('bbbbbbb22222222', 'src/time.h'),
      'time.h ' + String.fromCharCode(0xb7) + ' bbbbbbb',
      { preview: false, preserveFocus: false, viewColumn: 3 }
    );
  });

  it('compares the selected base commit directly with another commit instead of its parent', async () => {
    const newest = commit('ccccccc33333333', 'Me', 'me@example.com', 1_700_000_200, 'Newest');
    const repository = {
      getFileHistoryEntries: vi.fn(async () => [
        { commit: newest, path: 'src/new name.ts', parentPath: 'src/old name.ts' },
        { commit: mine, path: 'src/old name.ts', parentPath: 'src/older name.ts' }
      ]),
      getFileHistory: vi.fn(async () => []),
      getLineHistory: vi.fn(async () => []),
      getWorkingChanges: vi.fn(async () => [])
    };
    const controller = new HistoryController(registryWith(repository, 'src/new name.ts'));
    const source = join(ROOT, 'src/new name.ts');
    const model = await controller.getTimeline(source);
    const commits = model?.entries.filter((entry) => entry.kind === 'commit');
    if (model === undefined || commits?.length !== 2) throw new Error('timeline commits missing');
    mocks.executeCommand.mockClear();
    mocks.activeTextEditor.document.uri = mocks.Uri.file(source);
    mocks.activeTextEditor.viewColumn = 3;

    await controller.openTimelineComparison(model, commits[1]!.id, commits[0]!.id);

    expect(mocks.executeCommand).toHaveBeenNthCalledWith(
      1,
      'vscode.open',
      mocks.Uri.file(source),
      { preview: false, preserveFocus: true, viewColumn: 3 }
    );
    expect(mocks.executeCommand).toHaveBeenNthCalledWith(
      2,
      'vscode.diff',
      expectRevision(mine.hash, 'src/old name.ts'),
      expectRevision(newest.hash, 'src/new name.ts'),
      'new name.ts ' + String.fromCharCode(0xb7) + ' bbbbbbb → ccccccc',
      { preview: true, preserveFocus: false, viewColumn: 3 }
    );
  });

  it('calculates BASE-to-current totals for every selected path', async () => {
    const base = commit('1111111111111111', 'Me', 'me@example.com', 1_700_000_000, 'base');
    const gitStats = { added: 12, modified: 8, deleted: 3, paths: ['src/a.ts', 'src/b.ts'] };
    const getDiffStats = vi.fn(async () => gitStats);
    const controller = new HistoryController(registryWithFiles({ getDiffStats }, []));
    const getTimelineComparisonStats = (controller as unknown as {
      getTimelineComparisonStats?: (model: unknown, baseId: string, targetId?: string) => Promise<unknown>;
    }).getTimelineComparisonStats;
    const model = {
      root: ROOT,
      head: 'f'.repeat(40),
      sourcePath: ROOT,
      sourceExists: false,
      relativePath: '2 selected files',
      mode: 'selection',
      selectedPaths: ['src/a.ts', 'src/b.ts', 'src/new.ts'],
      currentPaths: ['src/a.ts', 'src/b.ts', 'src/new.ts'],
      untrackedPaths: ['src/new.ts'],
      untrackedOwnedLines: 4,
      entries: [{ id: `commit:${base.hash}`, kind: 'commit', commit: base, path: 'src/a.ts' }]
    };

    expect(getTimelineComparisonStats).toBeTypeOf('function');
    await expect(getTimelineComparisonStats?.call(controller, model, `commit:${base.hash}`)).resolves.toEqual({
      added: 16, modified: 8, deleted: 3, paths: ['src/a.ts', 'src/b.ts', 'src/new.ts']
    });
    expect(getDiffStats).toHaveBeenCalledWith(base.hash, undefined, ['src/a.ts', 'src/b.ts', 'src/new.ts']);
  });

  it('opens a selected-path BASE comparison in one reusable multi-diff editor', async () => {
    const base = commit('1111111111111111', 'Me', 'me@example.com', 1_700_000_000, 'base');
    const target = commit('2222222222222222', 'Me', 'me@example.com', 1_700_000_100, 'target');
    const getDiffStats = vi.fn(async () => ({
      added: 2, modified: 1, deleted: 0, paths: ['src/a.ts', 'src/b.ts']
    }));
    const controller = new HistoryController(registryWithFiles({ getDiffStats }, []));
    const model = {
      root: ROOT,
      head: 'f'.repeat(40),
      sourcePath: ROOT,
      sourceExists: false,
      relativePath: '2 selected files',
      mode: 'selection' as const,
      selectedPaths: ['src/a.ts', 'src/b.ts'],
      currentPaths: ['src/a.ts', 'src/b.ts'],
      entries: [
        { id: `commit:${base.hash}`, kind: 'commit' as const, commit: base, path: 'src/a.ts',
          title: base.subject, relativeDate: 'older', authoredAt: base.authoredAt, latest: false },
        { id: `commit:${target.hash}`, kind: 'commit' as const, commit: target, path: 'src/a.ts',
          title: target.subject, relativeDate: 'newer', authoredAt: target.authoredAt, latest: true }
      ]
    };

    await controller.openTimelineComparison(model, `commit:${base.hash}`, `commit:${target.hash}`);

    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.changes',
      '2 selected files · 1111111 → 2222222',
      [
        [expect.anything(), expectRevision(base.hash, 'src/a.ts'), expectRevision(target.hash, 'src/a.ts')],
        [expect.anything(), expectRevision(base.hash, 'src/b.ts'), expectRevision(target.hash, 'src/b.ts')]
      ]
    );
  });

  it('does not open a stale selected-path diff after its statistics finish', async () => {
    const base = commit('1111111111111111', 'Me', 'me@example.com', 1_700_000_000, 'base');
    const target = commit('2222222222222222', 'Me', 'me@example.com', 1_700_000_100, 'target');
    let release: ((value: { added: number; modified: number; deleted: number; paths: string[] }) => void) | undefined;
    const pending = new Promise<{ added: number; modified: number; deleted: number; paths: string[] }>(resolve => {
      release = resolve;
    });
    const controller = new HistoryController(registryWithFiles({ getDiffStats: vi.fn(() => pending) }, []));
    const model = {
      root: ROOT, head: 'f'.repeat(40), sourcePath: ROOT, sourceExists: false,
      relativePath: '2 selected files', mode: 'selection' as const,
      selectedPaths: ['src/a.ts'], currentPaths: ['src/a.ts'],
      entries: [
        { id: `commit:${base.hash}`, kind: 'commit' as const, commit: base, path: 'src/a.ts',
          title: base.subject, relativeDate: 'older', authoredAt: base.authoredAt, latest: false },
        { id: `commit:${target.hash}`, kind: 'commit' as const, commit: target, path: 'src/a.ts',
          title: target.subject, relativeDate: 'newer', authoredAt: target.authoredAt, latest: true }
      ]
    };
    const cancellation = { isCancellationRequested: false };

    const opening = controller.openTimelineComparison(
      model, `commit:${base.hash}`, `commit:${target.hash}`, cancellation
    );
    await Promise.resolve();
    cancellation.isCancellationRequested = true;
    release?.({ added: 1, modified: 0, deleted: 0, paths: ['src/a.ts'] });
    await opening;

    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('compares a commit base with current working changes', async () => {
    const repository = {
      getFileHistoryEntries: vi.fn(async () => [
        { commit: mine, path: 'src/time.h', parentPath: 'src/time.h' }
      ]),
      getFileHistory: vi.fn(async () => []),
      getLineHistory: vi.fn(async () => []),
      getWorkingChanges: vi.fn(async () => [{ status: '.M', path: 'src/time.h' }])
    };
    const controller = new HistoryController(registryWith(repository, 'src/time.h'));
    const source = join(ROOT, 'src/time.h');
    const model = await controller.getTimeline(source);
    const base = model?.entries.find((entry) => entry.kind === 'commit');
    if (model === undefined || base === undefined) throw new Error('timeline base missing');
    mocks.executeCommand.mockClear();

    await controller.openTimelineComparison(model, base.id, 'working');

    expect(mocks.executeCommand).toHaveBeenNthCalledWith(
      2,
      'vscode.diff',
      expectRevision(mine.hash, 'src/time.h'),
      mocks.Uri.file(source),
      'time.h ' + String.fromCharCode(0xb7) + ' bbbbbbb → Working changes',
      { preview: true, preserveFocus: false, viewColumn: 2 }
    );
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
      { preview: false }
    );
  });
  it('previews the highlighted history row without taking focus', async () => {
    const repository = {
      getFileHistoryEntries: vi.fn(async () => [{ commit: mine, path: 'src/a.ts', parentPath: 'src/a.ts' }]),
      getFileHistory: vi.fn(async () => [mine]),
      getLineHistory: vi.fn(async () => [mine]),
      getWorkingChanges: vi.fn(async () => []),
      showFile: vi.fn()
    };
    const registry = registryWith(repository, 'src/a.ts');
    mocks.activeTextEditor.document = {
      uri: mocks.Uri.file(join(ROOT, 'src/a.ts'))
    } as unknown as vscode.TextDocument;
    mocks.showQuickPick.mockImplementationOnce(async (items: unknown, options?: vscode.QuickPickOptions) => {
      options?.onDidSelectItem?.((items as HistoryQuickPickItem[])[0] as HistoryQuickPickItem);
      return undefined;
    });
    const controller = new HistoryController(registry, () => 1_700_086_400_000);

    await controller.showFileHistory();
    await Promise.resolve();

    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expectRevision('bbbbbbb22222222^', 'src/a.ts'),
      expectRevision('bbbbbbb22222222', 'src/a.ts'),
      'src/a.ts — My change (bbbbbbb)',
      { preview: true, preserveFocus: true }
    );
  });

  it('returns inline file and line history only when hovering one of my owned lines', async () => {
    const repository = {
      getFileHistoryEntries: vi.fn(async () => []),
      getFileHistory: vi.fn(async () => [other, mine]),
      getLineHistory: vi.fn(async () => [other, mine]),
      getWorkingChanges: vi.fn(async () => []),
      showFile: vi.fn()
    };
    const ownedRange: FileRecord['ranges'][number] = {
      start: 4, endExclusive: 6, commit: mine, uncommitted: false
    };
    const controller = new HistoryController(
      registryWith(repository, 'src/line.ts', [ownedRange], [other, mine])
    );

    const preview = await controller.getHistoryPreview(join(ROOT, 'src/line.ts'), 4);
    const outside = await controller.getHistoryPreview(join(ROOT, 'src/line.ts'), 2);

    expect(repository.getLineHistory).toHaveBeenCalledWith('src/line.ts', 5);
    expect(preview).toEqual({
      ownedRange,
      fileHistory: [mine],
      lineHistory: [mine]
    });
    expect(outside).toBeUndefined();
  });

  it('reuses inline history for repeated hover on the same repository snapshot and line', async () => {
    const repository = {
      getFileHistoryEntries: vi.fn(async () => []),
      getFileHistory: vi.fn(async () => [mine]),
      getLineHistory: vi.fn(async () => [mine]),
      getWorkingChanges: vi.fn(async () => []),
      showFile: vi.fn()
    };
    const ownedRange: FileRecord['ranges'][number] = {
      start: 4, endExclusive: 6, commit: mine, uncommitted: false
    };
    const controller = new HistoryController(registryWith(repository, 'src/line.ts', [ownedRange]));

    await controller.getHistoryPreview(join(ROOT, 'src/line.ts'), 4);
    await controller.getHistoryPreview(join(ROOT, 'src/line.ts'), 4);

    expect(repository.getLineHistory).toHaveBeenCalledTimes(1);
  });

  it('stops inline history after cancellation while working state is loading', async () => {
    let resolveWorking: ((value: []) => void) | undefined;
    const working = new Promise<[]>((resolve) => { resolveWorking = resolve; });
    const repository = {
      getFileHistoryEntries: vi.fn(async () => []),
      getFileHistory: vi.fn(async () => [mine]),
      getLineHistory: vi.fn(async () => [mine]),
      getWorkingChanges: vi.fn(() => working),
      showFile: vi.fn()
    };
    const ownedRange: FileRecord['ranges'][number] = {
      start: 4, endExclusive: 6, commit: mine, uncommitted: false
    };
    const cancellation = { isCancellationRequested: false };
    const controller = new HistoryController(registryWith(repository, 'src/line.ts', [ownedRange]));

    const pending = controller.getHistoryPreview(
      join(ROOT, 'src/line.ts'),
      4,
      cancellation as Pick<vscode.CancellationToken, 'isCancellationRequested'>
    );
    await Promise.resolve();
    cancellation.isCancellationRequested = true;
    resolveWorking?.([]);

    expect(await pending).toBeUndefined();
    expect(repository.getLineHistory).not.toHaveBeenCalled();
  });

  it('does not let a cancelled first hover poison a concurrent active hover for the same line', async () => {
    let resolveWorking: ((value: []) => void) | undefined;
    const working = new Promise<[]>((resolve) => { resolveWorking = resolve; });
    const repository = {
      getFileHistoryEntries: vi.fn(async () => []),
      getFileHistory: vi.fn(async () => [mine]),
      getLineHistory: vi.fn(async () => [mine]),
      getWorkingChanges: vi.fn(() => working),
      showFile: vi.fn()
    };
    const ownedRange: FileRecord['ranges'][number] = {
      start: 4, endExclusive: 6, commit: mine, uncommitted: false
    };
    const firstCancellation = { isCancellationRequested: false };
    const activeCancellation = { isCancellationRequested: false };
    const controller = new HistoryController(registryWith(repository, 'src/line.ts', [ownedRange]));

    const first = controller.getHistoryPreview(join(ROOT, 'src/line.ts'), 4, firstCancellation);
    await Promise.resolve();
    const active = controller.getHistoryPreview(join(ROOT, 'src/line.ts'), 4, activeCancellation);
    firstCancellation.isCancellationRequested = true;
    resolveWorking?.([]);

    expect(await first).toBeUndefined();
    expect(await active).toEqual(expect.objectContaining({ lineHistory: [mine] }));
    expect(repository.getLineHistory).toHaveBeenCalledTimes(1);
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
      { preview: false }
    );
    expect(mocks.executeCommand).toHaveBeenNthCalledWith(
      2, 'vscode.diff',
      expectRevision('bbbbbbb22222222^', 'root file.ts'),
      expectRevision('bbbbbbb22222222', 'root file.ts'),
      'root file.ts — Root add (bbbbbbb)',
      { preview: false }
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
      'src/line.ts:5 — My change (bbbbbbb)', { preview: false }
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

function registryWith(
  repository: Record<string, unknown>,
  relativePath?: string,
  ranges: FileRecord['ranges'] = [],
  history: readonly CommitSummary[] = [mine]
) {
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
          binary: false, ranges, history
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

function registryWithFiles(repository: Record<string, unknown>, files: readonly FileRecord[]) {
  const entry = {
    root: ROOT,
    state: 'ready' as const,
    repository,
    analyzer: {
      getSnapshot: () => ({
        root: ROOT,
        head: 'f'.repeat(40),
        identity,
        files,
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
