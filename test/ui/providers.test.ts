import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  const translate = vi.fn((message: string) => message);
  return { EventEmitter, Uri, ThemeColor, ThemeIcon, FileDecoration, TreeItem, translate };
});

vi.mock('vscode', () => ({
  EventEmitter: mocks.EventEmitter,
  Uri: mocks.Uri,
  ThemeColor: mocks.ThemeColor,
  ThemeIcon: mocks.ThemeIcon,
  FileDecoration: mocks.FileDecoration,
  TreeItem: mocks.TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  env: { language: 'en' },
  l10n: { t: mocks.translate }
}));
const ROOT = join(process.cwd(), 'repo');

import { MyCodeDecorationProvider } from '../../src/ui/fileDecorations.js';
import { MyCodeTreeProvider, PastActivityTreeProvider, type MyCodeNode } from '../../src/ui/myCodeTree.js';
import type { FileRecord, RepositorySnapshot } from '../../src/core/model.js';
import type { RepositoryRegistry } from '../../src/extension/repositoryRegistry.js';

describe('MyCodeDecorationProvider', () => {
  beforeEach(() => mocks.translate.mockImplementation((message: string) => message));

  it('decorates files and collapsed parent folders directly from the snapshot', () => {
    const registry = fakeRegistry(snapshot(ROOT, [
      file('src/added.ts', 'added'),
      file('src/nested/modified.ts', 'modified'),
      file('only-added/new.ts', 'added')
    ]));
    const provider = new MyCodeDecorationProvider(registry);

    const root = provider.provideFileDecoration(uri(ROOT));
    const src = provider.provideFileDecoration(uri(join(ROOT, 'src')));
    const onlyAdded = provider.provideFileDecoration(uri(join(ROOT, 'only-added')));
    const added = provider.provideFileDecoration(uri(join(ROOT, 'src', 'added.ts')));
    const modified = provider.provideFileDecoration(uri(join(ROOT, 'src', 'nested', 'modified.ts')));

    expect(root).toMatchObject({ badge: undefined, color: { id: 'gitDecoration.modifiedResourceForeground' }, propagate: true });
    expect(src).toMatchObject({ badge: undefined, color: { id: 'gitDecoration.modifiedResourceForeground' }, propagate: true });
    expect(onlyAdded).toMatchObject({ badge: undefined, color: { id: 'gitDecoration.addedResourceForeground' }, propagate: true });
    expect(added).toMatchObject({ badge: 'A', tooltip: 'Added by you', color: { id: 'gitDecoration.addedResourceForeground' }, propagate: true });
    expect(modified).toMatchObject({ badge: 'M', tooltip: 'Modified by you', color: { id: 'gitDecoration.modifiedResourceForeground' }, propagate: true });
    provider.dispose();
  });

  it('localizes Explorer ownership tooltips', () => {
    mocks.translate.mockImplementation((message: string) => ({
      'Added by you': '내가 추가함',
      'Modified by you': '내가 수정함'
    })[message] ?? message);
    const provider = new MyCodeDecorationProvider(fakeRegistry(snapshot(ROOT, [file('added.ts', 'added')])));

    expect(provider.provideFileDecoration(uri(join(ROOT, 'added.ts')))).toMatchObject({ tooltip: '내가 추가함' });
    provider.dispose();
  });

  it('invalidates Explorer colors only when the visible ownership state changes', () => {
    const registry = fakeRegistry(snapshot(ROOT, [file('current.ts', 'modified')]));
    const provider = new MyCodeDecorationProvider(registry);
    const changes: unknown[] = [];
    provider.onDidChangeFileDecorations((uri) => changes.push(uri));

    registry.emit();
    registry.publish(snapshot(ROOT, [file('current.ts', 'modified')], 2));
    expect(changes).toEqual([]);

    registry.publish(snapshot(ROOT, [file('current.ts', 'added')], 3));
    expect(changes).toEqual([undefined]);

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

  it('invalidates root decorations and skips lazy analysis while My Code visuals are disabled', () => {
    const registry = fakeRegistry(snapshot(ROOT, [file('candidate.ts', 'past')]));
    const provider = new MyCodeDecorationProvider(registry);
    const changes: unknown[] = [];
    provider.onDidChangeFileDecorations((uri) => changes.push(uri));

    provider.setEnabled(false);

    expect(changes).toEqual([undefined]);
    expect(provider.provideFileDecoration(uri(join(ROOT, 'candidate.ts')))).toBeUndefined();
    expect(registry.entry.analyzer.ensureFile).not.toHaveBeenCalled();

    provider.setEnabled(true);

    expect(changes).toEqual([undefined, undefined]);
    provider.dispose();
  });
});

describe('MyCodeTreeProvider', () => {
  it('caches the current graph by visible projection and returns parents and expandable nodes', () => {
    const registry = fakeRegistry(snapshot(ROOT, [file('src/nested/current.ts', 'modified')]));
    const provider = new MyCodeTreeProvider(registry);
    const firstRoots = provider.getChildren();
    const secondRoots = provider.getChildren();
    const src = firstRoots[0] as MyCodeNode;
    const nested = src.children[0] as MyCodeNode;
    const current = nested.children[0] as MyCodeNode;

    expect(secondRoots[0]).toBe(src);
    expect(provider.getParent(src)).toBeUndefined();
    expect(provider.getParent(nested)).toBe(src);
    expect(provider.getParent(current)).toBe(nested);
    expect(provider.expandableNodes()).toEqual([src, nested]);

    (registry.entry.analyzer as { getSnapshot: () => RepositorySnapshot }).getSnapshot = () => snapshot(ROOT, [file('src/nested/current.ts', 'modified')], 2);
    expect(provider.getChildren()[0]).toBe(src);
    provider.dispose();
  });

  it('keeps MY CHANGES stable when only the analyzer generation changes', () => {
    const registry = fakeRegistry(snapshot(ROOT, [file('current.ts', 'modified')]));
    const provider = new MyCodeTreeProvider(registry);
    const first = provider.getChildren()[0];
    const changes: unknown[] = [];
    provider.onDidChangeTreeData((node) => changes.push(node));

    registry.publish(snapshot(ROOT, [file('current.ts', 'modified')], 2));
    expect(changes).toEqual([]);
    expect(provider.getChildren()[0]).toBe(first);

    registry.publish(snapshot(ROOT, [file('current.ts', 'added')], 3));
    expect(changes).toEqual([undefined]);
    const changed = provider.getChildren()[0] as MyCodeNode;
    expect(provider.getTreeItem(changed).description).toBe('A');
    provider.dispose();
  });

  it('does not invalidate MY CHANGES when a manual view refresh sees the same final tree', async () => {
    const registry = fakeRegistry(snapshot(ROOT, [file('current.ts', 'modified')]));
    const provider = new MyCodeTreeProvider(registry);
    const changes: unknown[] = [];
    provider.onDidChangeTreeData((node) => changes.push(node));
    provider.getChildren();

    await provider.refresh();

    expect(changes).toEqual([]);
    provider.dispose();
  });

  it('renders current files as Explorer resources', () => {
    const provider = new MyCodeTreeProvider(fakeRegistry(snapshot(ROOT, [file('current.ts', 'modified')])));
    const current = provider.getChildren()[0] as MyCodeNode;
    expect(provider.getTreeItem(current)).toMatchObject({
      collapsibleState: 0,
      resourceUri: { fsPath: join(ROOT, 'current.ts') },
      command: { command: 'myCode.openFile' },
      contextValue: 'myCode.file',
      description: 'M'
    });
    provider.dispose();
  });
  it('returns no roots when no repository is ready', () => {
    const provider = new MyCodeTreeProvider(fakeRegistry(snapshot(ROOT, []), undefined, 'initializing'));

    expect(provider.getChildren()).toEqual([]);
    provider.dispose();
  });

  it('returns no roots for an empty ready repository so the welcome content remains visible', () => {
    const provider = new MyCodeTreeProvider(fakeRegistry(snapshot(ROOT, [])));

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
  let snapshotValue = currentSnapshot;
  const entry = {
    root: currentSnapshot.root,
    state,
    analyzer: {
      getSnapshot: () => snapshotValue,
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
    },
    emit: () => listeners.forEach((listener) => listener()),
    publish: (nextSnapshot: RepositorySnapshot) => {
      snapshotValue = nextSnapshot;
      listeners.forEach((listener) => listener());
    }
  } as unknown as RepositoryRegistry & {
    readonly entry: typeof entry;
    emit(): void;
    publish(snapshot: RepositorySnapshot): void;
  };
}

function snapshot(root: string, files: readonly FileRecord[], generatedAt = 1): RepositorySnapshot {
  return { root, head: 'head', identity: { name: 'Me', email: 'me@example.com' }, files, scanning: false, generatedAt };
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

describe('PastActivityTreeProvider', () => {
  it('renders flat past activity rows as history-only nodes with parent path and latest time', () => {
    const provider = new PastActivityTreeProvider(fakeRegistry(snapshot(ROOT, [
      { ...file('src/deleted.ts', 'past', false), history: [{ hash: 'abcdef123456', authorName: 'Me', authorEmail: 'me@example.com', authoredAt: 7, subject: 'Add auth' }] }
    ])));
    const past = provider.getChildren()[0];
    if (past === undefined) throw new Error('expected a past activity row');

    expect(provider.getTreeItem(past)).toMatchObject({
      collapsibleState: 0,
      command: { command: 'myCode.focusFileHistory', arguments: [join(ROOT, 'src', 'deleted.ts')] },
      resourceUri: undefined,
      contextValue: 'myCode.pastFile',
      iconPath: { id: 'history' }
    });
    expect(provider.getTreeItem(past).description).toContain('src');
    expect(provider.getChildren(past)).toEqual([]);
    provider.dispose();
  });

  it('keeps PAST ACTIVITY stable until its visible timeline changes', () => {
    const original = { ...file('old.ts', 'past', false), history: [{ hash: 'a', authorName: 'Me', authorEmail: 'me@example.com', authoredAt: 7, subject: 'Old' }] };
    const registry = fakeRegistry(snapshot(ROOT, [original]));
    const provider = new PastActivityTreeProvider(registry);
    const changes: unknown[] = [];
    provider.onDidChangeTreeData((node) => changes.push(node));
    provider.getChildren();

    registry.publish(snapshot(ROOT, [original], 2));
    expect(changes).toEqual([]);

    const updated = { ...original, history: [{ hash: 'b', authorName: 'Me', authorEmail: 'me@example.com', authoredAt: 8, subject: 'Updated' }] };
    registry.publish(snapshot(ROOT, [updated], 3));

    expect(changes).toEqual([undefined]);
    provider.dispose();
  });

  it('does not invalidate PAST ACTIVITY when a manual view refresh sees the same final timeline', async () => {
    const original = { ...file('old.ts', 'past', false), history: [{ hash: 'a', authorName: 'Me', authorEmail: 'me@example.com', authoredAt: 7, subject: 'Old' }] };
    const registry = fakeRegistry(snapshot(ROOT, [original]));
    const provider = new PastActivityTreeProvider(registry);
    const changes: unknown[] = [];
    provider.onDidChangeTreeData((node) => changes.push(node));
    provider.getChildren();

    await provider.refresh();

    expect(changes).toEqual([]);
    provider.dispose();
  });
});
