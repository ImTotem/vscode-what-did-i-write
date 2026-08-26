import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    public readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    public fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    public dispose(): void {
      this.listeners.clear();
    }
  }
  class Uri {
    public constructor(public readonly fsPath: string) {}
    public static file(path: string): Uri {
      return new Uri(path);
    }
    public toString(): string {
      return this.fsPath;
    }
  }
  class ThemeColor {
    public constructor(public readonly id: string) {}
  }
  class ThemeIcon {
    public constructor(public readonly id: string) {}
  }
  class FileDecoration {
    public propagate = false;
    public constructor(
      public readonly badge: string,
      public readonly tooltip: string,
      public readonly color: ThemeColor
    ) {}
  }
  class TreeItem {
    public description: string | undefined;
    public tooltip: string | undefined;
    public resourceUri: Uri | undefined;
    public command: { command: string; title: string; arguments?: unknown[] } | undefined;
    public contextValue: string | undefined;
    public iconPath: ThemeIcon | undefined;
    public constructor(public readonly label: string, public readonly collapsibleState: number) {}
  }
  return { EventEmitter, Uri, ThemeColor, ThemeIcon, FileDecoration, TreeItem };
});

vi.mock('vscode', () => ({
  EventEmitter: mocks.EventEmitter,
  Uri: mocks.Uri,
  ThemeColor: mocks.ThemeColor,
  ThemeIcon: mocks.ThemeIcon,
  FileDecoration: mocks.FileDecoration,
  TreeItem: mocks.TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }
}));
const ROOT = join(process.cwd(), 'repo');

import { MyCodeDecorationProvider } from '../../src/ui/fileDecorations.js';
import { MyCodeTreeProvider, type MyCodeNode } from '../../src/ui/myCodeTree.js';
import type { FileRecord, RepositorySnapshot } from '../../src/core/model.js';
import type { RepositoryRegistry } from '../../src/extension/repositoryRegistry.js';

describe('MyCodeDecorationProvider', () => {
  it('decorates current files and propagates their A/M state without decorating a repository root', () => {
    const registry = fakeRegistry(snapshot(ROOT, [
      file('added.ts', 'added'),
      file('modified.ts', 'modified')
    ]));
    const provider = new MyCodeDecorationProvider(registry);

    const added = provider.provideFileDecoration(uri(join(ROOT, 'added.ts')));
    const modified = provider.provideFileDecoration(uri(join(ROOT, 'modified.ts')));

    expect(added).toMatchObject({ badge: 'A', tooltip: 'Added by you', color: { id: 'gitDecoration.addedResourceForeground' }, propagate: true });
    expect(modified).toMatchObject({ badge: 'M', tooltip: 'Modified by you', color: { id: 'gitDecoration.modifiedResourceForeground' }, propagate: true });
    expect(provider.provideFileDecoration(uri(ROOT))).toBeUndefined();
    provider.dispose();
  });

  it('lazily resolves an unresolved candidate and invalidates decorations after success or failure', async () => {
    const success = deferred<FileRecord | undefined>();
    const registry = fakeRegistry(snapshot(ROOT, [file('candidate.ts', 'past')]), success.promise);
    const onError = vi.fn();
    const provider = new MyCodeDecorationProvider(registry, onError);
    const changes: unknown[] = [];
    provider.onDidChangeFileDecorations((uri) => changes.push(uri));
    const candidateUri = uri(join(ROOT, 'candidate.ts'));

    expect(provider.provideFileDecoration(candidateUri)).toBeUndefined();
    expect(registry.entry.analyzer.ensureFile).toHaveBeenCalledWith('candidate.ts', 'explorer');
    success.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toEqual([candidateUri]);

    const failure = deferred<FileRecord | undefined>();
    registry.entry.analyzer.ensureFile.mockReturnValueOnce(failure.promise);
    expect(provider.provideFileDecoration(candidateUri)).toBeUndefined();
    failure.reject(new Error('blame failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toEqual([candidateUri, candidateUri]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'explorer-ownership', 'candidate.ts');
    provider.dispose();
  });

  it('does not duplicate a resolution error already reported by the analyzer', async () => {
    const failure = deferred<FileRecord | undefined>();
    const registry = fakeRegistry(snapshot(ROOT, [file('candidate.ts', 'past')]), failure.promise);
    (registry.entry.analyzer as unknown as { reportsErrors: boolean }).reportsErrors = true;
    const onError = vi.fn();
    const provider = new MyCodeDecorationProvider(registry, onError);

    provider.provideFileDecoration(uri(join(ROOT, 'candidate.ts')));
    failure.reject(new Error('already reported blame failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('returns no decoration for an empty or non-ready repository', () => {
    const registry = fakeRegistry(snapshot(ROOT, []), undefined, 'initializing');
    const provider = new MyCodeDecorationProvider(registry);

    expect(provider.provideFileDecoration(uri(join(ROOT, 'file.ts')))).toBeUndefined();
    expect(registry.entry.analyzer.ensureFile).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('suppresses decorations and lazy resolution while analysis is paused for identity', () => {
    const paused = {
      ...snapshot(ROOT, [file('stale.ts', 'modified')]),
      identity: { name: '', email: '   ' }
    };
    const registry = fakeRegistry(paused);
    const provider = new MyCodeDecorationProvider(registry);

    expect(provider.provideFileDecoration(uri(join(ROOT, 'stale.ts')))).toBeUndefined();
    expect(registry.entry.analyzer.ensureFile).not.toHaveBeenCalled();
    provider.dispose();
  });
});

describe('MyCodeTreeProvider', () => {
  it('renders file, deleted-past, and history item commands, context values, URIs, and tooltips', () => {
    const commit = { hash: 'abcdef123456', authorName: 'Me', authorEmail: 'me@example.com', authoredAt: 1, subject: 'Add auth' };
    const registry = fakeRegistry(snapshot(ROOT, [
      file('current.ts', 'modified'),
      { ...file('deleted.ts', 'past', false), history: [commit] }
    ]));
    const provider = new MyCodeTreeProvider(registry);
    const roots = provider.getChildren();
    const current = roots[0]?.children[0] as MyCodeNode;
    const past = roots[1]?.children[0] as MyCodeNode;

    const currentItem = provider.getTreeItem(current);
    expect(currentItem).toMatchObject({
      resourceUri: { fsPath: join(ROOT, 'current.ts') },
      command: { command: 'myCode.openFile' },
      contextValue: 'myCode.file',
      description: 'M'
    });
    const pastItem = provider.getTreeItem(past);
    expect(pastItem).toMatchObject({
      command: undefined,
      resourceUri: undefined,
      contextValue: 'myCode.pastFile',
      description: '◷',
      iconPath: { id: 'history' }
    });
    const history = provider.getChildren(past)[0] as MyCodeNode;
    const historyItem = provider.getTreeItem(history);
    expect(historyItem).toMatchObject({ command: { command: 'myCode.openCommitDiff' }, contextValue: 'myCode.history' });
    expect(historyItem.tooltip).toContain('abcdef123456');
    expect(historyItem.tooltip).toContain('Me <me@example.com>');
    expect(historyItem.tooltip).toContain('Add auth');
    provider.dispose();
  });

  it('returns no roots when no repository is ready', () => {
    const provider = new MyCodeTreeProvider(fakeRegistry(snapshot(ROOT, []), undefined, 'initializing'));

    expect(provider.getChildren()).toEqual([]);
    provider.dispose();
  });

  it('returns no tree output while analysis is paused for identity', () => {
    const paused = {
      ...snapshot(ROOT, [file('stale.ts', 'modified')]),
      identity: { name: '', email: '' }
    };
    const provider = new MyCodeTreeProvider(fakeRegistry(paused));

    expect(provider.getChildren()).toEqual([]);
    provider.dispose();
  });
});

function uri(path: string): vscode.Uri {
  return mocks.Uri.file(path) as unknown as vscode.Uri;
}

function fakeRegistry(
  currentSnapshot: RepositorySnapshot,
  ensureFileResult: Promise<FileRecord | undefined> | undefined = undefined,
  state: 'ready' | 'initializing' = 'ready'
) {
  const listeners = new Set<() => void>();
  const entry = {
    root: currentSnapshot.root,
    state,
    analyzer: {
      getSnapshot: () => currentSnapshot,
      ensureFile: vi.fn(() => ensureFileResult ?? Promise.resolve(undefined))
    }
  };
  return {
    entry,
    repositories: [entry],
    findByUri: vi.fn((uri: { fsPath: string }) => uri.fsPath.startsWith(currentSnapshot.root) ? entry : undefined),
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }
  } as unknown as RepositoryRegistry & { readonly entry: typeof entry };
}

function snapshot(root: string, files: readonly FileRecord[]): RepositorySnapshot {
  return { root, head: 'head', identity: { name: 'Me', email: 'me@example.com' }, files, scanning: false, generatedAt: 1 };
}

function file(relativePath: string, kind: FileRecord['kind'], exists = true): FileRecord {
  return { relativePath, kind, exists, working: false, binary: false, ranges: [], history: [] };
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: (value: T) => resolvePromise?.(value), reject: (reason: unknown) => rejectPromise?.(reason) };
}
