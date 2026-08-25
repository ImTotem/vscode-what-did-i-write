import { describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  class Position {
    public constructor(public readonly line: number, public readonly character: number) {}
  }
  class Range {
    public constructor(public readonly start: Position, public readonly end: Position) {}
  }
  class MarkdownString {
    public value = '';
    public isTrusted: boolean | { enabledCommands: readonly string[] } | undefined;
    public appendMarkdown(value: string): MarkdownString {
      this.value += value;
      return this;
    }
  }
  class ThemeColor {
    public constructor(public readonly id: string) {}
  }
  const decorations: Array<{ options: unknown; dispose: ReturnType<typeof vi.fn> }> = [];
  const activeListeners = new Set<() => void>();
  const visibleListeners = new Set<() => void>();
  const documentListeners = new Set<(event: { document: vscode.TextDocument }) => void>();
  const saveListeners = new Set<(document: vscode.TextDocument) => void>();
  const configuration = { lineBackground: false, updates: [] as unknown[][] };
  const window = {
    visibleTextEditors: [] as readonly vscode.TextEditor[],
    createTextEditorDecorationType: (options: unknown) => {
      const value = { options, dispose: vi.fn() };
      decorations.push(value);
      return value;
    },
    onDidChangeActiveTextEditor: (listener: () => void) => {
      activeListeners.add(listener);
      return { dispose: () => activeListeners.delete(listener) };
    },
    onDidChangeVisibleTextEditors: (listener: () => void) => {
      visibleListeners.add(listener);
      return { dispose: () => visibleListeners.delete(listener) };
    }
  };
  return {
    Position, Range, MarkdownString, ThemeColor, decorations, activeListeners, visibleListeners, documentListeners, saveListeners, configuration, window
  };
});

vi.mock('vscode', () => ({
  Position: mocks.Position,
  Range: mocks.Range,
  MarkdownString: mocks.MarkdownString,
  ThemeColor: mocks.ThemeColor,
  OverviewRulerLane: { Left: 1 },
  window: mocks.window,
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, fallback: T) => (mocks.configuration.lineBackground as unknown as T) ?? fallback,
      update: (...args: unknown[]) => { mocks.configuration.updates.push(args); return Promise.resolve(); }
    }),
    onDidChangeTextDocument: (listener: (event: { document: vscode.TextDocument }) => void) => {
      mocks.documentListeners.add(listener);
      return { dispose: () => mocks.documentListeners.delete(listener) };
    },
    onDidSaveTextDocument: (listener: (document: vscode.TextDocument) => void) => {
      mocks.saveListeners.add(listener);
      return { dispose: () => mocks.saveListeners.delete(listener) };
    }
  }
}));

import {
  EditorOwnershipController,
  commandUri,
  toDecorationOptions
} from '../../src/ui/editorOwnership.js';
import type { FileRecord } from '../../src/core/model.js';
import type { RepositoryRegistry } from '../../src/extension/repositoryRegistry.js';

const committed = {
  hash: 'abcdef1234567890', authorName: 'Me <owner>', authorEmail: 'me@example.com', authoredAt: 1_700_000_000, subject: 'Fix markdown <escaping>'
};

describe('toDecorationOptions', () => {
  it('maps end-exclusive ranges, clips to the document, and creates trusted commit hover links', () => {
    const document = documentFor('/repo/src/a file.ts', 3);
    const result = toDecorationOptions(record([
      { start: 1, endExclusive: 3, commit: committed, uncommitted: false },
      { start: 2, endExclusive: 9, commit: undefined, uncommitted: true }
    ]), document, commandUri);

    expect(result).toHaveLength(2);
    expect(result[0]?.range).toEqual({ start: { line: 1, character: 0 }, end: { line: 3, character: 0 } });
    expect(result[1]?.range).toEqual({ start: { line: 2, character: 0 }, end: { line: 3, character: 0 } });
    const hover = result[0]?.hoverMessage as unknown as { value: string; isTrusted: unknown };
    expect(hover.value).toContain('abcdef1');
    expect(hover.value).toContain('Me &lt;owner&gt;');
    expect(hover.value).toContain('Fix markdown &lt;escaping&gt;');
    expect(hover.value).toContain('$(history) File history');
    expect(hover.value).toContain('$(list-tree) Line history');
    expect(hover.isTrusted).toEqual({ enabledCommands: ['myCode.showFileHistory', 'myCode.showLineHistory'] });
  });

  it('encodes command arguments as JSON before URI escaping', () => {
    expect(commandUri('myCode.showLineHistory', [{ path: 'src/a b.ts', line: 2 }])).toBe(
      `command:myCode.showLineHistory?${encodeURIComponent(JSON.stringify([{ path: 'src/a b.ts', line: 2 }]))}`
    );
  });
});

describe('EditorOwnershipController', () => {
  it('decorates only source documents, asks the analyzer at active-editor priority, and clears stale results', async () => {
    const current = record([{ start: 0, endExclusive: 2, commit: committed, uncommitted: false }]);
    const stale = deferred<FileRecord | undefined>();
    const fresh = deferred<FileRecord | undefined>();
    const registry = fakeRegistry(current, Promise.resolve(undefined));
    registry.entry.analyzer.ensureFile.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const editor = editorFor(documentFor('/repo/current.ts', 3));
    const virtual = editorFor(documentFor('/repo/revision.ts', 3, 'my-code-git'));
    setVisibleEditors([editor, virtual]);
    const controller = new EditorOwnershipController(registry);

    void controller.refreshVisibleEditors();
    await flush();
    expect(registry.entry.analyzer.ensureFile).toHaveBeenCalledWith('current.ts', 'active-editor');
    expect(editor.setDecorations).toHaveBeenCalledWith(expect.anything(), []);
    expect(virtual.setDecorations).not.toHaveBeenCalled();

    void controller.refreshUri(editor.document.uri);
    fresh.resolve(record([{ start: 2, endExclusive: 3, commit: undefined, uncommitted: true }]));
    await flush();
    stale.resolve(current);
    await flush();
    const lastDecorations = editor.setDecorations.mock.calls.slice(-2);
    expect(lastDecorations[0]?.[1]).toEqual([]);
    expect(lastDecorations[1]?.[1]).toEqual([expect.objectContaining({ range: expect.objectContaining({ start: expect.objectContaining({ line: 2 }) }) })]);
    controller.dispose();
  });

  it('keeps dirty buffers clear through registry and visible-editor refreshes until save analysis resolves', async () => {
    const old = record([{ start: 0, endExclusive: 2, commit: committed, uncommitted: false }]);
    const fresh = record([{ start: 2, endExclusive: 3, commit: undefined, uncommitted: true }]);
    const analysis = deferred<void>();
    let isFresh = false;
    const registry = fakeRegistry(old, Promise.resolve(old));
    registry.entry.analyzer.ensureFile.mockImplementation(async () => isFresh ? fresh : old);
    registry.entry.analyzer.refresh.mockImplementation(async () => {
      await analysis.promise;
      isFresh = true;
      registry.publish(fresh);
    });
    const editor = editorFor(documentFor('/repo/current.ts', 3));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry);

    await controller.refreshVisibleEditors();
    editor.setDecorations.mockClear();
    for (const listener of mocks.documentListeners) listener({ document: editor.document });
    registry.emit();
    for (const listener of mocks.visibleListeners) listener();
    await flush();
    expect(registry.entry.analyzer.ensureFile).toHaveBeenCalledTimes(1);
    expect(editor.setDecorations.mock.calls.every(([, options]) => Array.isArray(options) && options.length === 0)).toBe(true);

    for (const listener of mocks.saveListeners) listener(editor.document);
    registry.emit();
    for (const listener of mocks.visibleListeners) listener();
    await flush();
    expect(registry.entry.analyzer.refresh).toHaveBeenCalledWith('working-tree', ['current.ts']);
    expect(registry.entry.analyzer.ensureFile).toHaveBeenCalledTimes(1);
    expect(editor.setDecorations.mock.calls.every(([, options]) => Array.isArray(options) && options.length === 0)).toBe(true);

    analysis.resolve();
    await flush();
    expect(editor.setDecorations.mock.calls.slice(-1)[0]?.[1]).toEqual([expect.objectContaining({ range: expect.objectContaining({ start: expect.objectContaining({ line: 2 }) }) })]);
    controller.dispose();
  });

  it('creates committed green and working blue decorations, applies inclusive full-document ranges, and disposes', () => {
    mocks.decorations.splice(0);
    const registry = fakeRegistry(record([]), Promise.resolve(undefined));
    const controller = new EditorOwnershipController(registry);
    const decorations = mocks.decorations.slice(-2);
    expect(decorations).toHaveLength(2);
    expect(decorations[0]?.options).toMatchObject({
      isWholeLine: true,
      borderWidth: '0 0 0 2px',
      borderStyle: 'solid',
      borderColor: { id: 'gitDecoration.addedResourceForeground' },
      overviewRulerColor: { id: 'gitDecoration.addedResourceForeground' },
      overviewRulerLane: 1
    });
    expect(decorations[1]?.options).toMatchObject({
      borderColor: { id: 'gitDecoration.modifiedResourceForeground' },
      overviewRulerColor: { id: 'gitDecoration.modifiedResourceForeground' }
    });
    controller.dispose();
    expect(decorations.map(({ dispose }) => dispose.mock.calls.length)).toEqual([1, 1]);
  });
});

function record(ranges: FileRecord['ranges']): FileRecord {
  return { relativePath: 'current.ts', kind: 'modified', exists: true, working: false, binary: false, ranges, history: [committed] };
}

function documentFor(path: string, lineCount: number, scheme = 'file'): vscode.TextDocument {
  return { uri: { fsPath: path, scheme, toString: () => `${scheme}:${path}` }, lineCount } as unknown as vscode.TextDocument;
}

function editorFor(document: vscode.TextDocument) {
  return { document, setDecorations: vi.fn() } as unknown as vscode.TextEditor & { setDecorations: ReturnType<typeof vi.fn> };
}

function setVisibleEditors(editors: readonly vscode.TextEditor[]): void {
  mocks.window.visibleTextEditors = editors;
}

function fakeRegistry(current: FileRecord, ensureResult: Promise<FileRecord | undefined>) {
  const listeners = new Set<() => void>();
  let currentFile = current;
  let generatedAt = 1;
  const entry = {
    root: '/repo', state: 'ready' as const,
    analyzer: {
      getSnapshot: () => ({ root: '/repo', head: 'h', identity: { name: 'Me', email: 'me@example.com' }, files: [currentFile], scanning: false, generatedAt }),
      refresh: vi.fn(async () => undefined),
      ensureFile: vi.fn(() => ensureResult)
    }
  };
  return {
    entry,
    findByUri: vi.fn((uri: { fsPath: string }) => uri.fsPath.startsWith('/repo/') ? entry : undefined),
    emit: () => { for (const listener of listeners) listener(); },
    publish: (file: FileRecord) => { currentFile = file; generatedAt += 1; },
    onDidChange: (listener: () => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }
  } as unknown as RepositoryRegistry & {
    readonly entry: typeof entry;
    emit(): void;
    publish(file: FileRecord): void;
  };
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: (value: T) => resolvePromise?.(value) };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
