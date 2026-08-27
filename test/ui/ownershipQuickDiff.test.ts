import { resolve } from 'node:path';

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
    public readonly authority = '';
    public readonly query = '';
    public readonly fragment = '';
    public constructor(
      public readonly scheme: string,
      public readonly path: string,
      public readonly fsPath: string
    ) {}
    public static file(path: string): Uri {
      return new Uri('file', path.replace(/\\/g, '/'), path);
    }
    public static from(parts: { scheme: string; path: string }): Uri {
      return new Uri(parts.scheme, parts.path, parts.path);
    }
    public toString(): string {
      return `${this.scheme}:${this.path}`;
    }
  }

  const sourceControls: Array<{
    id: string;
    label: string;
    rootUri: Uri;
    inputBox: { visible: boolean };
    count?: number;
    quickDiffProvider?: unknown;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const documents = new Map<string, { uri: Uri; isDirty: boolean; version: number; getText(): string }>();
  const openTextDocument = vi.fn(async (uri: Uri) => {
    const document = documents.get(uri.fsPath);
    if (document === undefined) throw new Error(`missing document: ${uri.fsPath}`);
    return document;
  });
  return { EventEmitter, Uri, sourceControls, documents, openTextDocument };
});

vi.mock('vscode', () => ({
  EventEmitter: mocks.EventEmitter,
  Uri: mocks.Uri,
  scm: {
    createSourceControl: (id: string, label: string, rootUri: InstanceType<typeof mocks.Uri>) => {
      const sourceControl = {
        id,
        label,
        rootUri,
        inputBox: { visible: true },
        dispose: vi.fn()
      };
      mocks.sourceControls.push(sourceControl);
      return sourceControl;
    }
  },
  workspace: {
    openTextDocument: mocks.openTextDocument
  }
}));

import {
  OWNERSHIP_ORIGINAL_SCHEME,
  OwnershipQuickDiffController,
  omitOwnedLines,
  parseOwnershipOriginalUri
} from '../../src/ui/ownershipQuickDiff.js';
import type { RegisteredRepository, RepositoryRegistry } from '../../src/extension/repositoryRegistry.js';

describe('omitOwnedLines', () => {
  it('removes overlapping owned ranges while preserving unowned CRLF content and the final newline', () => {
    const result = omitOwnedLines('zero\r\none\r\ntwo\r\nthree\r\n', [
      { start: 1, endExclusive: 3 },
      { start: 2, endExclusive: 99 }
    ]);

    expect(result).toBe('zero\r\n');
  });
});

describe('OwnershipQuickDiffController', () => {
  beforeEach(() => {
    mocks.sourceControls.splice(0);
    mocks.documents.clear();
    mocks.openTextDocument.mockReset().mockImplementation(async (uri: InstanceType<typeof mocks.Uri>) => {
      const document = mocks.documents.get(uri.fsPath);
      if (document === undefined) throw new Error(`missing document: ${uri.fsPath}`);
      return document;
    });
  });

  it('registers a native quick diff source for each repository and removes authored lines from its original document', async () => {
    const root = resolve('fixture/repo');
    const sourcePath = resolve(root, 'src/current.ts');
    const registry = fakeRegistry(root, {
      relativePath: 'src/current.ts',
      kind: 'modified',
      exists: true,
      working: false,
      binary: false,
      ranges: [{ start: 1, endExclusive: 2, uncommitted: false }],
      history: []
    });
    const sourceUri = mocks.Uri.file(sourcePath) as unknown as vscode.Uri;
    mocks.documents.set(sourcePath, {
      uri: sourceUri as unknown as InstanceType<typeof mocks.Uri>,
      isDirty: false,
      version: 1,
      getText: () => 'kept\nauthored\nkept too\n'
    });
    const controller = new OwnershipQuickDiffController(registry, () => true);

    await controller.setEnabled(true);
    const original = await controller.provideOriginalResource(
      sourceUri,
      { isCancellationRequested: false } as vscode.CancellationToken
    );

    expect(mocks.sourceControls).toHaveLength(1);
    expect(mocks.sourceControls[0]).toMatchObject({
      label: 'What Did I Write?',
      count: 0,
      inputBox: { visible: false },
      quickDiffProvider: controller
    });
    expect(original?.scheme).toBe(OWNERSHIP_ORIGINAL_SCHEME);
    expect(parseOwnershipOriginalUri(original as vscode.Uri)).toEqual({
      root,
      path: 'src/current.ts'
    });
    await expect(controller.provideTextDocumentContent(original as vscode.Uri)).resolves.toBe(
      'kept\nkept too\n'
    );
    controller.dispose();
    expect(mocks.sourceControls[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('disconnects native quick diff while visuals are disabled without disposing repository state', async () => {
    const root = resolve('fixture/repo');
    const registry = fakeRegistry(root, undefined);
    const controller = new OwnershipQuickDiffController(registry, () => true);
    await controller.setEnabled(true);

    await controller.setEnabled(false);

    expect(mocks.sourceControls[0]?.quickDiffProvider).toBeUndefined();
    await expect(controller.provideOriginalResource(
      mocks.Uri.file(resolve(root, 'src/current.ts')) as unknown as vscode.Uri,
      { isCancellationRequested: false } as vscode.CancellationToken
    )).resolves.toBeUndefined();
    expect(mocks.sourceControls[0]?.dispose).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('does not publish ranges resolved after the document snapshot becomes stale', async () => {
    const root = resolve('fixture/race');
    const sourcePath = resolve(root, 'current.ts');
    const record = ownedRecord('current.ts', 1);
    const fixture = mutableRegistry(root, record);
    let current = true;
    const document = {
      uri: mocks.Uri.file(sourcePath),
      isDirty: false,
      version: 1,
      getText: () => 'zero\none\ntwo\n'
    };
    mocks.documents.set(sourcePath, document);
    const controller = new OwnershipQuickDiffController(fixture.registry, () => current);
    await controller.setEnabled(true);
    const original = await controller.provideOriginalResource(
      document.uri as unknown as vscode.Uri,
      cancellation()
    );
    const pending = deferred<TestRecord | undefined>();
    fixture.ensureFile.mockReturnValueOnce(pending.promise);

    const content = controller.provideTextDocumentContent(original as vscode.Uri);
    await flush();
    current = false;
    document.isDirty = true;
    document.version += 1;
    pending.resolve(record);

    await expect(content).resolves.toBe('zero\none\ntwo\n');
    controller.dispose();
  });

  it('replays a pending fingerprint only after editor analysis becomes current', async () => {
    const root = resolve('fixture/replay');
    const sourcePath = resolve(root, 'current.ts');
    const fixture = mutableRegistry(root, ownedRecord('current.ts', 1));
    const state = snapshotState(true);
    const document = {
      uri: mocks.Uri.file(sourcePath),
      isDirty: false,
      version: 1,
      getText: () => 'zero\none\ntwo\n'
    };
    mocks.documents.set(sourcePath, document);
    const controller = new OwnershipQuickDiffController(fixture.registry, state.access);
    await controller.setEnabled(true);
    const original = await controller.provideOriginalResource(
      document.uri as unknown as vscode.Uri,
      cancellation()
    );
    await expect(controller.provideTextDocumentContent(original as vscode.Uri)).resolves.toBe(
      'zero\ntwo\n'
    );
    const refreshed: Promise<string>[] = [];
    controller.onDidChange((uri) => {
      refreshed.push(Promise.resolve(controller.provideTextDocumentContent(uri)));
    });

    state.setCurrent(false, document.uri as unknown as vscode.Uri);
    fixture.setRecord(ownedRecord('current.ts', 2));
    fixture.emit();
    await flush();
    expect(refreshed).toHaveLength(0);

    state.setCurrent(true, document.uri as unknown as vscode.Uri);
    await flush();
    expect(refreshed).toHaveLength(1);
    await expect(refreshed[0]).resolves.toBe('zero\none\n');
    controller.dispose();
  });

  it('does not return or track an original resolved after visuals are disabled', async () => {
    const root = resolve('fixture/disabled');
    const record = ownedRecord('current.ts', 0);
    const fixture = mutableRegistry(root, record);
    const pending = deferred<TestRecord | undefined>();
    fixture.ensureFile.mockReturnValueOnce(pending.promise);
    const controller = new OwnershipQuickDiffController(fixture.registry, () => true);
    await controller.setEnabled(true);

    const original = controller.provideOriginalResource(
      mocks.Uri.file(resolve(root, 'current.ts')) as unknown as vscode.Uri,
      cancellation()
    );
    await flush();
    await controller.setEnabled(false);
    pending.resolve(record);

    await expect(original).resolves.toBeUndefined();
    controller.dispose();
  });

  it('does not materialize content completed after cancellation', async () => {
    const root = resolve('fixture/cancelled');
    const sourcePath = resolve(root, 'current.ts');
    const record = ownedRecord('current.ts', 1);
    const fixture = mutableRegistry(root, record);
    const document = {
      uri: mocks.Uri.file(sourcePath),
      isDirty: false,
      version: 1,
      getText: () => 'zero\none\ntwo\n'
    };
    mocks.documents.set(sourcePath, document);
    const controller = new OwnershipQuickDiffController(fixture.registry, () => true);
    await controller.setEnabled(true);
    const original = await controller.provideOriginalResource(
      document.uri as unknown as vscode.Uri,
      cancellation()
    );
    const pending = deferred<TestRecord | undefined>();
    fixture.ensureFile.mockReturnValueOnce(pending.promise);
    const token = { isCancellationRequested: false };

    const content = controller.provideTextDocumentContent(
      original as vscode.Uri,
      token as vscode.CancellationToken
    );
    await flush();
    token.isCancellationRequested = true;
    pending.resolve(record);

    await expect(content).resolves.toBe('zero\none\ntwo\n');
    await expect(controller.provideTextDocumentContent(original as vscode.Uri)).resolves.toBe(
      'zero\ntwo\n'
    );
    controller.dispose();
  });

  it('keeps the newest materialization when an older analyzer request finishes last', async () => {
    const root = resolve('fixture/overlap');
    const sourcePath = resolve(root, 'current.ts');
    const first = ownedRecord('current.ts', 0);
    const second = ownedRecord('current.ts', 1);
    const latest = ownedRecord('current.ts', 2);
    const fixture = mutableRegistry(root, first);
    const document = {
      uri: mocks.Uri.file(sourcePath),
      isDirty: false,
      version: 1,
      getText: () => 'zero\none\ntwo\nthree\n'
    };
    mocks.documents.set(sourcePath, document);
    const controller = new OwnershipQuickDiffController(fixture.registry, snapshotState(true).access);
    await controller.setEnabled(true);
    const original = await controller.provideOriginalResource(
      document.uri as unknown as vscode.Uri,
      cancellation()
    );
    await expect(controller.provideTextDocumentContent(original as vscode.Uri)).resolves.toBe(
      'one\ntwo\nthree\n'
    );
    const pendingSecond = deferred<TestRecord | undefined>();
    const pendingLatest = deferred<TestRecord | undefined>();
    fixture.ensureFile
      .mockReturnValueOnce(pendingSecond.promise)
      .mockReturnValueOnce(pendingLatest.promise);
    const refreshed: Promise<string>[] = [];
    controller.onDidChange((uri) => refreshed.push(controller.provideTextDocumentContent(uri)));

    fixture.setRecord(second);
    fixture.emit();
    await flush();
    fixture.setRecord(latest);
    fixture.emit();
    await flush();
    expect(refreshed).toHaveLength(2);

    pendingLatest.resolve(latest);
    await flush();
    pendingSecond.resolve(second);

    await expect(Promise.all(refreshed)).resolves.toEqual([
      'zero\none\nthree\n',
      'zero\none\nthree\n'
    ]);
    await expect(controller.provideTextDocumentContent(original as vscode.Uri)).resolves.toBe(
      'zero\none\nthree\n'
    );
    controller.dispose();
  });

  it('retries a notified fingerprint when VS Code cancels its content request', async () => {
    const root = resolve('fixture/cancelled-notification');
    const sourcePath = resolve(root, 'current.ts');
    const first = ownedRecord('current.ts', 0);
    const next = ownedRecord('current.ts', 1);
    const fixture = mutableRegistry(root, first);
    const document = {
      uri: mocks.Uri.file(sourcePath),
      isDirty: false,
      version: 1,
      getText: () => 'zero\none\ntwo\n'
    };
    mocks.documents.set(sourcePath, document);
    const controller = new OwnershipQuickDiffController(fixture.registry, snapshotState(true).access);
    await controller.setEnabled(true);
    const original = await controller.provideOriginalResource(
      document.uri as unknown as vscode.Uri,
      cancellation()
    );
    await controller.provideTextDocumentContent(original as vscode.Uri);
    const pending = deferred<TestRecord | undefined>();
    fixture.ensureFile.mockReturnValueOnce(pending.promise);
    const token = { isCancellationRequested: false };
    const refreshed: Promise<string>[] = [];
    controller.onDidChange((uri) => refreshed.push(controller.provideTextDocumentContent(
      uri,
      refreshed.length === 0 ? token as vscode.CancellationToken : cancellation()
    )));

    fixture.setRecord(next);
    fixture.emit();
    await flush();
    token.isCancellationRequested = true;
    pending.resolve(next);
    await flush();
    await flush();

    expect(refreshed).toHaveLength(2);
    await expect(refreshed[1]).resolves.toBe('zero\ntwo\n');
    controller.dispose();
  });

  it('keeps an in-flight repository current when an unrelated root is removed', async () => {
    const removedRoot = resolve('fixture/multi/a');
    const activeRoot = resolve('fixture/multi/b');
    const sourcePath = resolve(activeRoot, 'current.ts');
    const first = ownedRecord('current.ts', 0);
    const latest = ownedRecord('current.ts', 2);
    const fixture = multiRootRegistry([
      [removedRoot, ownedRecord('a.ts', 0)],
      [activeRoot, first]
    ]);
    const document = {
      uri: mocks.Uri.file(sourcePath),
      isDirty: false,
      version: 1,
      getText: () => 'zero\none\ntwo\n'
    };
    mocks.documents.set(sourcePath, document);
    const controller = new OwnershipQuickDiffController(fixture.registry, snapshotState(true).access);
    await controller.setEnabled(true);
    const original = await controller.provideOriginalResource(
      document.uri as unknown as vscode.Uri,
      cancellation()
    );
    await controller.provideTextDocumentContent(original as vscode.Uri);
    const pending = deferred<TestRecord | undefined>();
    fixture.ensureFile(activeRoot).mockReturnValueOnce(pending.promise);
    const refreshed: Promise<string>[] = [];
    controller.onDidChange((uri) => refreshed.push(controller.provideTextDocumentContent(uri)));

    fixture.setRecord(activeRoot, latest);
    fixture.emit();
    await flush();
    fixture.remove(removedRoot);
    pending.resolve(latest);

    await expect(refreshed[0]).resolves.toBe('zero\none\n');
    controller.dispose();
  });

  it('reports source-open failures and allows an unchanged fingerprint to retry', async () => {
    const root = resolve('fixture/open-failure');
    const sourcePath = resolve(root, 'current.ts');
    const first = ownedRecord('current.ts', 0);
    const next = ownedRecord('current.ts', 1);
    const fixture = mutableRegistry(root, first);
    const document = {
      uri: mocks.Uri.file(sourcePath),
      isDirty: false,
      version: 1,
      getText: () => 'zero\none\ntwo\n'
    };
    mocks.documents.set(sourcePath, document);
    const report = vi.fn();
    const controller = new OwnershipQuickDiffController(
      fixture.registry,
      snapshotState(true).access,
      report
    );
    await controller.setEnabled(true);
    const original = await controller.provideOriginalResource(
      document.uri as unknown as vscode.Uri,
      cancellation()
    );
    await controller.provideTextDocumentContent(original as vscode.Uri);
    const failure = new Error('source was renamed');
    mocks.openTextDocument.mockRejectedValueOnce(failure);
    const refreshed: Promise<string>[] = [];
    controller.onDidChange((uri) => refreshed.push(controller.provideTextDocumentContent(uri)));

    fixture.setRecord(next);
    fixture.emit();
    await flush();
    await expect(refreshed[0]).resolves.toBe('one\ntwo\n');
    expect(report).toHaveBeenCalledWith(failure, 'quick-diff-content', 'current.ts');

    fixture.emit();
    await flush();
    expect(refreshed).toHaveLength(2);
    await expect(refreshed[1]).resolves.toBe('zero\ntwo\n');
    controller.dispose();
  });

  it('suppresses missing-identity and binary resources and disposes removed repositories', async () => {
    const root = resolve('fixture/lifecycle');
    const fixture = mutableRegistry(root, {
      ...ownedRecord('current.bin', 0),
      binary: true
    });
    const controller = new OwnershipQuickDiffController(fixture.registry, () => true);
    await controller.setEnabled(true);
    fixture.setIdentity({ name: '', email: '' });

    await expect(controller.provideOriginalResource(
      mocks.Uri.file(resolve(root, 'current.bin')) as unknown as vscode.Uri,
      cancellation()
    )).resolves.toBeUndefined();
    fixture.remove();
    expect(mocks.sourceControls[0]?.dispose).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('rejects malformed virtual original URIs', () => {
    expect(() => parseOwnershipOriginalUri(
      mocks.Uri.from({ scheme: OWNERSHIP_ORIGINAL_SCHEME, path: '/not-base64!' }) as unknown as vscode.Uri
    )).toThrow('Invalid ownership original URI payload');
  });
});

function fakeRegistry(
  root: string,
  record: ReturnType<RegisteredRepository['analyzer']['getSnapshot']>['files'][number] | undefined
): RepositoryRegistry {
  const listeners = new Set<() => void>();
  const snapshot = {
    root,
    head: 'abc',
    identity: { name: 'Me', email: 'me@example.com' },
    files: record === undefined ? [] : [record],
    scanning: false,
    generatedAt: 1
  };
  const entry = {
    root,
    ready: true,
    state: 'ready',
    repository: {},
    workspaceFolders: [],
    analyzer: {
      getSnapshot: () => snapshot,
      ensureFile: vi.fn(async () => record)
    }
  } as unknown as RegisteredRepository;
  return {
    repositories: [entry],
    findByUri: (uri: { fsPath: string }) => uri.fsPath.startsWith(root) ? entry : undefined,
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }
  } as unknown as RepositoryRegistry;
}

type TestRecord = ReturnType<RegisteredRepository['analyzer']['getSnapshot']>['files'][number];

function ownedRecord(path: string, line: number): TestRecord {
  return {
    relativePath: path,
    kind: 'modified',
    exists: true,
    working: false,
    binary: false,
    ranges: [{ start: line, endExclusive: line + 1, uncommitted: false }],
    history: []
  };
}

function mutableRegistry(root: string, initialRecord: TestRecord | undefined) {
  const listeners = new Set<() => void>();
  let record = initialRecord;
  let identity = { name: 'Me', email: 'me@example.com' };
  let generatedAt = 1;
  const ensureFile = vi.fn(async () => record);
  const entry = {
    root,
    ready: true,
    state: 'ready',
    repository: {},
    workspaceFolders: [],
    analyzer: {
      getSnapshot: () => ({
        root,
        head: 'abc',
        identity,
        files: record === undefined ? [] : [record],
        scanning: false,
        generatedAt
      }),
      ensureFile
    }
  } as unknown as RegisteredRepository;
  let repositories: RegisteredRepository[] = [entry];
  const registry = {
    get repositories() { return repositories; },
    findByUri: (uri: { fsPath: string }) => repositories.includes(entry) && uri.fsPath.startsWith(root)
      ? entry
      : undefined,
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }
  } as unknown as RepositoryRegistry;
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    registry,
    ensureFile,
    emit,
    setRecord: (next: TestRecord | undefined) => {
      record = next;
      generatedAt += 1;
    },
    setIdentity: (next: { name: string; email: string }) => { identity = next; },
    remove: () => {
      repositories = [];
      emit();
    }
  };
}

function multiRootRegistry(
  initial: readonly (readonly [root: string, record: TestRecord | undefined])[]
) {
  const listeners = new Set<() => void>();
  const records = new Map(initial);
  const ensureFiles = new Map<string, ReturnType<typeof vi.fn>>();
  let repositories = initial.map(([root]) => {
    const ensureFile = vi.fn(async () => records.get(root));
    ensureFiles.set(root, ensureFile);
    return {
      root,
      ready: true,
      state: 'ready',
      repository: {},
      workspaceFolders: [],
      analyzer: {
        getSnapshot: () => ({
          root,
          head: 'abc',
          identity: { name: 'Me', email: 'me@example.com' },
          files: records.get(root) === undefined ? [] : [records.get(root)],
          scanning: false,
          generatedAt: 1
        }),
        ensureFile
      }
    } as unknown as RegisteredRepository;
  });
  const registry = {
    get repositories() { return repositories; },
    findByUri: (uri: { fsPath: string }) => repositories.find((entry) => uri.fsPath.startsWith(entry.root)),
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }
  } as unknown as RepositoryRegistry;
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    registry,
    emit,
    ensureFile: (root: string) => ensureFiles.get(root) as ReturnType<typeof vi.fn>,
    setRecord: (root: string, record: TestRecord | undefined) => records.set(root, record),
    remove: (root: string) => {
      repositories = repositories.filter((entry) => entry.root !== root);
      emit();
    }
  };
}

function snapshotState(initial: boolean) {
  let current = initial;
  const emitter = new mocks.EventEmitter<vscode.Uri>();
  return {
    access: {
      isDocumentSnapshotCurrent: () => current,
      isUriSnapshotCurrent: () => current,
      onDidChangeSnapshotState: emitter.event
    },
    setCurrent: (next: boolean, uri: vscode.Uri) => {
      current = next;
      emitter.fire(uri);
    }
  };
}

function cancellation(cancelled = false): vscode.CancellationToken {
  return { isCancellationRequested: cancelled } as vscode.CancellationToken;
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (value: T) => resolvePromise?.(value)
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
