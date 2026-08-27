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
  const documents = new Map<string, { uri: Uri; isDirty: boolean; getText(): string }>();
  return { EventEmitter, Uri, sourceControls, documents };
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
    openTextDocument: async (uri: InstanceType<typeof mocks.Uri>) => {
      const document = mocks.documents.get(uri.fsPath);
      if (document === undefined) throw new Error(`missing document: ${uri.fsPath}`);
      return document;
    }
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
