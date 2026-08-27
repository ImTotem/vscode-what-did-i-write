import { join, resolve, sep } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

import { CacheStore } from '../../src/analysis/cacheStore.js';
import {
  RepositoryAnalyzer,
  type AnalyzerFileSystem,
  type RepositoryAccess as AnalyzerRepositoryAccess
} from '../../src/analysis/repositoryAnalyzer.js';
import type { FileRecord, GitIdentity } from '../../src/core/model.js';
import type { BlameLine, WorkingChange } from '../../src/git/parsers.js';
import type { UserIndex } from '../../src/git/repository.js';

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
  const closeListeners = new Set<(document: vscode.TextDocument) => void>();
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
    Position, Range, MarkdownString, ThemeColor, decorations, activeListeners, visibleListeners,
    documentListeners, saveListeners, closeListeners, configuration, window
  };
});

vi.mock('vscode', () => ({
  Position: mocks.Position,
  Range: mocks.Range,
  MarkdownString: mocks.MarkdownString,
  ThemeColor: mocks.ThemeColor,
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  OverviewRulerLane: { Left: 1, Full: 7 },
  window: mocks.window,
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, fallback: T) => (mocks.configuration.lineBackground as unknown as T) ?? fallback,
      update: (...args: unknown[]) => {
        mocks.configuration.updates.push(args);
        if (args[0] === 'editor.lineBackground' && args[2] === 2) {
          mocks.configuration.lineBackground = args[1] as boolean;
        }
        return Promise.resolve();
      }
    }),
    onDidChangeTextDocument: (listener: (event: { document: vscode.TextDocument }) => void) => {
      mocks.documentListeners.add(listener);
      return { dispose: () => mocks.documentListeners.delete(listener) };
    },
    onDidSaveTextDocument: (listener: (document: vscode.TextDocument) => void) => {
      mocks.saveListeners.add(listener);
      return { dispose: () => mocks.saveListeners.delete(listener) };
    },
    onDidCloseTextDocument: (listener: (document: vscode.TextDocument) => void) => {
      mocks.closeListeners.add(listener);
      return { dispose: () => mocks.closeListeners.delete(listener) };
    }
  },
  env: { language: 'en' },
  l10n: { t: (message: string) => message }
}));

import {
  EditorOwnershipController,
  commandUri,
  toDecorationOptions
} from '../../src/ui/editorOwnership.js';
import type { RepositoryRegistry } from '../../src/extension/repositoryRegistry.js';

const committed = {
  hash: 'abcdef1234567890', authorName: 'Me <owner>', authorEmail: 'me@example.com', authoredAt: 1_700_000_000, subject: 'Fix markdown <escaping>'
};

describe('toDecorationOptions', () => {
  it('maps end-exclusive ranges without attaching hover cards to code ranges', () => {
    const document = documentFor('/repo/src/a file.ts', 3);
    const result = toDecorationOptions(record([
      { start: 1, endExclusive: 3, commit: committed, uncommitted: false },
      { start: 2, endExclusive: 9, commit: undefined, uncommitted: true }
    ]), document);

    expect(result).toHaveLength(3);
    expect(result[0]?.range).toEqual({ start: { line: 1, character: 0 }, end: { line: 1, character: 0 } });
    expect(result[1]?.range).toEqual({ start: { line: 2, character: 0 }, end: { line: 2, character: 0 } });
    expect(result[2]?.range).toEqual({ start: { line: 2, character: 0 }, end: { line: 2, character: 0 } });
    expect(result.every((option) => option.hoverMessage === undefined)).toBe(true);
  });

  it('encodes command arguments as JSON before URI escaping', () => {
    expect(commandUri('myCode.showLineHistory', [{ path: 'src/a b.ts', line: 2 }])).toBe(
      `command:myCode.showLineHistory?${encodeURIComponent(JSON.stringify([{ path: 'src/a b.ts', line: 2 }]))}`
    );
  });
});

describe('EditorOwnershipController', () => {
  it('clears both decoration layers and suppresses repainting until visuals are re-enabled', async () => {
    const current = record([{ start: 0, endExclusive: 2, commit: committed, uncommitted: false }]);
    const registry = fakeRegistry(current, Promise.resolve(current));
    const editor = editorFor(documentFor('/repo/current.ts', 3));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry);

    await controller.refreshVisibleEditors();
    const resolvesBeforeDisable = registry.entry.analyzer.ensureFile.mock.calls.length;
    editor.setDecorations.mockClear();

    await controller.setEnabled(false);
    await controller.refreshVisibleEditors();

    expect(editor.setDecorations.mock.calls).toHaveLength(2);
    expect(editor.setDecorations.mock.calls.map(([, options]) => options)).toEqual([[], []]);
    expect(registry.entry.analyzer.ensureFile).toHaveBeenCalledTimes(resolvesBeforeDisable);

    await controller.setEnabled(true);

    expect(registry.entry.analyzer.ensureFile.mock.calls.length).toBeGreaterThan(resolvesBeforeDisable);
    expect(editor.setDecorations.mock.calls.slice(-2).some(([, options]) => Array.isArray(options) && options.length > 0)).toBe(true);
    controller.dispose();
  });

  it('does not repaint an editor when the resolved ownership fingerprint is unchanged', async () => {
    const current = record([{ start: 0, endExclusive: 2, commit: committed, uncommitted: false }]);
    const registry = fakeRegistry(current, Promise.resolve(current));
    const editor = editorFor(documentFor('/repo/current.ts', 3));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry);

    await controller.refreshVisibleEditors();
    const callsAfterFirstRefresh = editor.setDecorations.mock.calls.length;
    await controller.refreshVisibleEditors();

    const actualCalls = editor.setDecorations.mock.calls.length;
    controller.dispose();
    expect(callsAfterFirstRefresh).toBeGreaterThan(0);
    expect(actualCalls).toBe(callsAfterFirstRefresh);
  });

  it('keeps a known ownership record visible while resolution is pending', async () => {
    const current = record([{ start: 0, endExclusive: 2, commit: committed, uncommitted: false }]);
    const pending = deferred<FileRecord | undefined>();
    const registry = fakeRegistry(current, pending.promise);
    const editor = editorFor(documentFor('/repo/current.ts', 3));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry);

    void controller.refreshVisibleEditors();
    await flush();

    const hasOwned = editor.setDecorations.mock.calls.some(([, options]) =>
      Array.isArray(options) && options.length > 0
    );
    const emptyCalls = editor.setDecorations.mock.calls.filter(([, options]) =>
      Array.isArray(options) && options.length === 0
    ).length;
    pending.resolve(current);
    await flush();
    controller.dispose();
    expect(hasOwned).toBe(true);
    expect(emptyCalls).toBeLessThan(2);
  });

  it('uses extension-specific translucent background theme colors when enabled', () => {
    mocks.decorations.splice(0);
    mocks.configuration.lineBackground = true;
    const registry = fakeRegistry(record([]), Promise.resolve(undefined));
    const controller = new EditorOwnershipController(registry);
    const decorations = mocks.decorations.slice(-2);

    mocks.configuration.lineBackground = false;
    controller.dispose();
    expect(decorations[0]?.options).toMatchObject({
      backgroundColor: { id: 'myCode.editor.committedLineBackground' }
    });
    expect(decorations[1]?.options).toMatchObject({
      backgroundColor: { id: 'myCode.editor.workingLineBackground' }
    });
  });

  it('rebuilds decoration types and repaints visible editors after an external background setting change', async () => {
    mocks.decorations.splice(0);
    mocks.configuration.lineBackground = false;
    const current = record([{ start: 0, endExclusive: 1, commit: committed, uncommitted: false }]);
    const registry = fakeRegistry(current, Promise.resolve(current));
    const editor = editorFor(documentFor('/repo/current.ts', 2));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry);
    await controller.refreshVisibleEditors();
    const original = mocks.decorations.slice(-2);
    const repaintCalls = editor.setDecorations.mock.calls.length;

    mocks.configuration.lineBackground = true;
    await controller.acceptLineBackgroundConfigurationChange();

    const rebuilt = mocks.decorations.slice(-2);
    expect(original.map(({ dispose }) => dispose.mock.calls.length)).toEqual([1, 1]);
    expect(rebuilt[0]?.options).toMatchObject({
      backgroundColor: { id: 'myCode.editor.committedLineBackground' }
    });
    expect(rebuilt[1]?.options).toMatchObject({
      backgroundColor: { id: 'myCode.editor.workingLineBackground' }
    });
    expect(editor.setDecorations.mock.calls.length).toBeGreaterThan(repaintCalls);
    expect(editor.setDecorations.mock.calls.slice(-2).map(([decoration]) => decoration))
      .toEqual(rebuilt);
    mocks.configuration.lineBackground = false;
    controller.dispose();
  });

  it('toggles the effective background at Workspace scope and repaints with the new types', async () => {
    mocks.decorations.splice(0);
    mocks.configuration.updates.splice(0);
    mocks.configuration.lineBackground = false;
    const current = record([{ start: 0, endExclusive: 1, commit: committed, uncommitted: false }]);
    const registry = fakeRegistry(current, Promise.resolve(current));
    const editor = editorFor(documentFor('/repo/current.ts', 2));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry);

    await controller.toggleLineBackground();

    const rebuilt = mocks.decorations.slice(-2);
    expect(mocks.configuration.updates).toEqual([
      ['editor.lineBackground', true, 2]
    ]);
    expect(rebuilt[0]?.options).toHaveProperty('backgroundColor');
    expect(rebuilt[1]?.options).toHaveProperty('backgroundColor');
    expect(editor.setDecorations.mock.calls.slice(-2).map(([decoration]) => decoration))
      .toEqual(rebuilt);
    mocks.configuration.lineBackground = false;
    controller.dispose();
  });

  it('adopts external background changes while visuals are off without repainting until re-enabled', async () => {
    mocks.decorations.splice(0);
    mocks.configuration.lineBackground = false;
    const current = record([{ start: 0, endExclusive: 1, commit: committed, uncommitted: false }]);
    const registry = fakeRegistry(current, Promise.resolve(current));
    const editor = editorFor(documentFor('/repo/current.ts', 2));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry);
    await controller.refreshVisibleEditors();
    await controller.setEnabled(false);
    const callsWhileOff = editor.setDecorations.mock.calls.length;
    const resolvesWhileOff = registry.entry.analyzer.ensureFile.mock.calls.length;

    mocks.configuration.lineBackground = true;
    await controller.acceptLineBackgroundConfigurationChange();

    const rebuilt = mocks.decorations.slice(-2);
    expect(rebuilt[0]?.options).toHaveProperty('backgroundColor');
    expect(rebuilt[1]?.options).toHaveProperty('backgroundColor');
    expect(editor.setDecorations).toHaveBeenCalledTimes(callsWhileOff);
    expect(registry.entry.analyzer.ensureFile).toHaveBeenCalledTimes(resolvesWhileOff);

    await controller.setEnabled(true);

    expect(registry.entry.analyzer.ensureFile.mock.calls.length).toBeGreaterThan(resolvesWhileOff);
    expect(editor.setDecorations.mock.calls.slice(-2).map(([decoration]) => decoration))
      .toEqual(rebuilt);
    mocks.configuration.lineBackground = false;
    controller.dispose();
  });

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

  it('keeps the last confirmed decorations visible until save analysis replaces them', async () => {
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
    setDirty(editor.document, true);
    for (const listener of mocks.documentListeners) listener({ document: editor.document });
    expect(controller.isDocumentSnapshotCurrent(editor.document)).toBe(false);
    registry.emit();
    for (const listener of mocks.visibleListeners) listener();
    await flush();
    expect(registry.entry.analyzer.ensureFile).toHaveBeenCalledTimes(1);
    expect(editor.setDecorations).not.toHaveBeenCalled();

    setDirty(editor.document, false);
    for (const listener of mocks.saveListeners) listener(editor.document);
    expect(controller.isDocumentSnapshotCurrent(editor.document)).toBe(false);
    registry.emit();
    for (const listener of mocks.visibleListeners) listener();
    await flush();
    expect(registry.entry.analyzer.refresh).toHaveBeenCalledWith('working-tree', ['current.ts']);
    expect(registry.entry.analyzer.ensureFile).toHaveBeenCalledTimes(1);
    expect(editor.setDecorations).not.toHaveBeenCalled();

    analysis.resolve();
    await flush();
    expect(controller.isDocumentSnapshotCurrent(editor.document)).toBe(true);
    expect(editor.setDecorations.mock.calls.slice(-1)[0]?.[1]).toEqual([expect.objectContaining({ range: expect.objectContaining({ start: expect.objectContaining({ line: 2 }) }) })]);
    controller.dispose();
  });

  it('keeps confirmed ownership visible until a production analyzer replacement settles', async () => {
    const root = resolve('/repo');
    const replacement = deferred<BlameLine[]>();
    let blameCalls = 0;
    const repository = analyzerRepository(root, async () => {
      blameCalls += 1;
      if (blameCalls === 1) return [{ line: 0, commit: committed, uncommitted: false }];
      return replacement.promise;
    });
    const analyzer = new RepositoryAnalyzer(
      repository,
      new CacheStore(undefined),
      undefined,
      memoryFileSystem('first\nsecond\n')
    );
    await analyzer.initialize();
    await analyzer.ensureFile('current.ts', 'active-editor');
    await waitFor(() => !analyzer.getSnapshot().scanning);
    const registry = registryForAnalyzer(root, analyzer);
    const editor = editorFor(documentFor(join(root, 'current.ts'), 2));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry);
    await controller.refreshVisibleEditors();
    editor.setDecorations.mockClear();

    setDirty(editor.document, true);
    for (const listener of mocks.documentListeners) listener({ document: editor.document });
    setDirty(editor.document, false);
    for (const listener of mocks.saveListeners) listener(editor.document);
    await waitFor(() => blameCalls === 2);
    await flushTurns();

    expect(editor.setDecorations).not.toHaveBeenCalled();

    replacement.resolve([{ line: 1, commit: committed, uncommitted: false }]);
    await waitFor(() => hasDecorationAtLine(editor, 1));

    expect(hasDecorationAtLine(editor, 0)).toBe(false);
    controller.dispose();
    analyzer.dispose();
  });

  it('keeps confirmed ownership visible when a production replacement fails', async () => {
    const root = resolve('/repo');
    const failure = new Error('persistent replacement blame failure');
    let blameCalls = 0;
    const repository = analyzerRepository(root, async () => {
      blameCalls += 1;
      if (blameCalls === 1) return [{ line: 0, commit: committed, uncommitted: false }];
      throw failure;
    });
    const analyzerError = vi.fn();
    const analyzer = new RepositoryAnalyzer(
      repository,
      new CacheStore(undefined),
      analyzerError,
      memoryFileSystem('first\nsecond\n')
    );
    await analyzer.initialize();
    await analyzer.ensureFile('current.ts', 'active-editor');
    await waitFor(() => !analyzer.getSnapshot().scanning);
    const registry = registryForAnalyzer(root, analyzer);
    const editor = editorFor(documentFor(join(root, 'current.ts'), 2));
    setVisibleEditors([editor]);
    const controllerError = vi.fn();
    const controller = new EditorOwnershipController(registry, {
      onError: controllerError,
      scheduleRetry: (callback) => callback()
    });
    await controller.refreshVisibleEditors();
    editor.setDecorations.mockClear();

    setDirty(editor.document, true);
    for (const listener of mocks.documentListeners) listener({ document: editor.document });
    setDirty(editor.document, false);
    for (const listener of mocks.saveListeners) listener(editor.document);
    await waitFor(() => analyzerError.mock.calls.length > 0);
    await waitFor(() => !analyzer.getSnapshot().scanning);
    await flushTurns();

    expect(blameCalls).toBe(3);
    expect(analyzerError).toHaveBeenCalledTimes(2);
    expect(controllerError).not.toHaveBeenCalled();
    expect(editor.setDecorations).not.toHaveBeenCalled();
    controller.dispose();
    analyzer.dispose();
  });

  it('keeps save B gated when superseded save A settles first', async () => {
    const old = record([{ start: 0, endExclusive: 2, commit: committed, uncommitted: false }]);
    const fresh = record([{ start: 2, endExclusive: 3, commit: undefined, uncommitted: true }]);
    const saveA = deferred<void>();
    const saveB = deferred<void>();
    let refreshes = 0;
    let savedB = false;
    const registry = fakeRegistry(old, Promise.resolve(old));
    registry.entry.analyzer.ensureFile.mockImplementation(async () => savedB ? fresh : old);
    registry.entry.analyzer.refresh.mockImplementation(async () => {
      refreshes += 1;
      if (refreshes === 1) {
        await saveA.promise;
        return;
      }
      await saveB.promise;
      savedB = true;
      registry.publish(fresh);
    });
    const editor = editorFor(documentFor('/repo/current.ts', 3));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry);

    await controller.refreshVisibleEditors();
    editor.setDecorations.mockClear();
    setDirty(editor.document, true);
    for (const listener of mocks.documentListeners) listener({ document: editor.document });
    setDirty(editor.document, false);
    for (const listener of mocks.saveListeners) listener(editor.document);
    setDirty(editor.document, true);
    for (const listener of mocks.documentListeners) listener({ document: editor.document });
    setDirty(editor.document, false);
    for (const listener of mocks.saveListeners) listener(editor.document);
    await flush();
    expect(registry.entry.analyzer.refresh).toHaveBeenCalledTimes(2);

    saveA.resolve();
    await flush();
    expect(registry.entry.analyzer.ensureFile).toHaveBeenCalledTimes(1);
    expect(editor.setDecorations).not.toHaveBeenCalled();

    saveB.resolve();
    await flush();
    expect(editor.setDecorations.mock.calls.slice(-1)[0]?.[1]).toEqual([expect.objectContaining({ range: expect.objectContaining({ start: expect.objectContaining({ line: 2 }) }) })]);
    controller.dispose();
  });

  it('clears a discarded dirty latch on close so the same URI decorates after reopen', async () => {
    const current = record([{ start: 0, endExclusive: 1, commit: committed, uncommitted: false }]);
    const registry = fakeRegistry(current, Promise.resolve(current));
    const first = editorFor(documentFor('/repo/current.ts', 2));
    setVisibleEditors([first]);
    const controller = new EditorOwnershipController(registry);
    await controller.refreshVisibleEditors();

    setDirty(first.document, true);
    for (const listener of mocks.documentListeners) listener({ document: first.document });
    setVisibleEditors([]);
    for (const listener of mocks.closeListeners) listener(first.document);
    const reopened = editorFor(documentFor('/repo/current.ts', 2));
    setVisibleEditors([reopened]);

    await controller.refreshVisibleEditors();

    expect(registry.entry.analyzer.ensureFile).toHaveBeenCalledTimes(2);
    expect(reopened.setDecorations.mock.calls.slice(-2).some(([, options]) =>
      Array.isArray(options) && options.length > 0
    )).toBe(true);
    controller.dispose();
  });

  it('refreshes a clean document after undo without repainting an unchanged ownership result', async () => {
    const current = record([{ start: 0, endExclusive: 1, commit: committed, uncommitted: false }]);
    const registry = fakeRegistry(current, Promise.resolve(current));
    const editor = editorFor(documentFor('/repo/current.ts', 2));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry);
    await controller.refreshVisibleEditors();
    editor.setDecorations.mockClear();

    setDirty(editor.document, true);
    for (const listener of mocks.documentListeners) listener({ document: editor.document });
    setDirty(editor.document, false);
    for (const listener of mocks.documentListeners) listener({ document: editor.document });
    await flush();

    expect(registry.entry.analyzer.refresh).toHaveBeenCalledWith('working-tree', ['current.ts']);
    expect(editor.setDecorations).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('reports a rejected save refresh, retries once, and never repaints the stale record', async () => {
    const old = record([{ start: 0, endExclusive: 1, commit: committed, uncommitted: false }]);
    const fresh = record([{ start: 1, endExclusive: 2, commit: undefined, uncommitted: true }]);
    const onError = vi.fn();
    let attempts = 0;
    const registry = fakeRegistry(old, Promise.resolve(old));
    registry.entry.analyzer.ensureFile.mockImplementation(async () => attempts === 2 ? fresh : old);
    registry.entry.analyzer.refresh.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient refresh failure');
      registry.publish(fresh);
    });
    const editor = editorFor(documentFor('/repo/current.ts', 2));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry, {
      onError,
      scheduleRetry: (callback) => callback()
    });
    await controller.refreshVisibleEditors();
    editor.setDecorations.mockClear();

    setDirty(editor.document, true);
    for (const listener of mocks.documentListeners) listener({ document: editor.document });
    setDirty(editor.document, false);
    for (const listener of mocks.saveListeners) listener(editor.document);
    await flush();
    await flush();

    expect(registry.entry.analyzer.refresh).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'transient refresh failure' }),
      'editor-save-refresh',
      'current.ts'
    );
    expect(editor.setDecorations.mock.calls.slice(-1)[0]?.[1]).toEqual([
      expect.objectContaining({ range: expect.objectContaining({ start: expect.objectContaining({ line: 1 }) }) })
    ]);
    controller.dispose();
  });

  it('reports unexpected resolution failures while retaining the last valid ownership', async () => {
    const current = record([{ start: 0, endExclusive: 1, commit: committed, uncommitted: false }]);
    const error = new Error('unexpected blame failure');
    const onError = vi.fn();
    const registry = fakeRegistry(current, Promise.reject(error));
    const editor = editorFor(documentFor('/repo/current.ts', 2));
    setVisibleEditors([editor]);
    const controller = new EditorOwnershipController(registry, { onError });

    await controller.refreshVisibleEditors();

    expect(onError).toHaveBeenCalledWith(error, 'editor-ownership', 'current.ts');
    expect(editor.setDecorations.mock.calls.slice(-2).some(([, options]) =>
      Array.isArray(options) && options.length > 0
    )).toBe(true);
    controller.dispose();
  });

  it('keeps ownership markers out of code content and uses the gutter plus full overview ruler', () => {
    mocks.decorations.splice(0);
    const registry = fakeRegistry(record([]), Promise.resolve(undefined));
    const controller = new EditorOwnershipController(registry);
    const decorations = mocks.decorations.slice(-2);
    expect(decorations).toHaveLength(2);
    expect(decorations[0]?.options).toMatchObject({
      isWholeLine: true,
      gutterIconPath: expect.stringContaining('owned-committed.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: { id: 'gitDecoration.addedResourceForeground' },
      overviewRulerLane: 7
    });
    expect(decorations[0]?.options).not.toHaveProperty('borderWidth');
    expect(decorations[0]?.options).not.toHaveProperty('borderColor');
    expect(decorations[1]?.options).toMatchObject({
      gutterIconPath: expect.stringContaining('owned-working.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: { id: 'gitDecoration.modifiedResourceForeground' },
      overviewRulerLane: 7
    });
    expect(decorations[1]?.options).not.toHaveProperty('borderWidth');
    expect(decorations[1]?.options).not.toHaveProperty('borderColor');
    controller.dispose();
    expect(decorations.map(({ dispose }) => dispose.mock.calls.length)).toEqual([1, 1]);
    expect(mocks.closeListeners.size).toBe(0);
  });
});

function record(ranges: FileRecord['ranges']): FileRecord {
  return { relativePath: 'current.ts', kind: 'modified', exists: true, working: false, binary: false, ranges, history: [committed] };
}

function documentFor(path: string, lineCount: number, scheme = 'file'): vscode.TextDocument {
  return { uri: { fsPath: path, scheme, toString: () => `${scheme}:${path}` }, lineCount, isDirty: false } as unknown as vscode.TextDocument;
}

function editorFor(document: vscode.TextDocument) {
  return { document, setDecorations: vi.fn() } as unknown as vscode.TextEditor & { setDecorations: ReturnType<typeof vi.fn> };
}

function setVisibleEditors(editors: readonly vscode.TextEditor[]): void {
  mocks.window.visibleTextEditors = editors;
}

function setDirty(document: vscode.TextDocument, isDirty: boolean): void {
  (document as unknown as { isDirty: boolean }).isDirty = isDirty;
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

function analyzerRepository(
  root: string,
  runBlame: (path: string) => Promise<BlameLine[]>
): AnalyzerRepositoryAccess {
  return {
    root,
    getGlobalIdentity: async (): Promise<GitIdentity> => ({ name: 'Me', email: 'me@example.com' }),
    getHead: async () => 'a'.repeat(40),
    getUserIndex: async (): Promise<UserIndex> => ({
      commits: [committed],
      entries: [{ commit: committed, changes: [{ status: 'M', path: 'current.ts' }] }]
    }),
    getWorkingChanges: async (): Promise<WorkingChange[]> => [],
    blame: runBlame
  };
}

function memoryFileSystem(contents: string): AnalyzerFileSystem {
  const bytes = Buffer.from(contents);
  return {
    stat: async () => ({ isFile: () => true }),
    open: async () => {
      let cursor = 0;
      return {
        read: async (buffer, offset, length, position) => {
          const start = position ?? cursor;
          const bytesRead = Math.max(0, Math.min(length, bytes.length - start));
          bytes.copy(buffer, offset, start, start + bytesRead);
          cursor = start + bytesRead;
          return { bytesRead };
        },
        close: async () => undefined
      };
    }
  };
}

function registryForAnalyzer(root: string, analyzer: RepositoryAnalyzer): RepositoryRegistry {
  const entry = {
    root,
    state: 'ready' as const,
    ready: true,
    analyzer,
    workspaceFolders: [{ fsPath: root }]
  };
  return {
    findByUri: (uri: { fsPath: string }) => uri.fsPath.startsWith(`${root}${sep}`) ? entry : undefined,
    onDidChange: (listener: () => void) => analyzer.onDidChange(() => listener())
  } as unknown as RepositoryRegistry;
}

function hasDecorationAtLine(
  editor: vscode.TextEditor & { setDecorations: ReturnType<typeof vi.fn> },
  line: number
): boolean {
  return editor.setDecorations.mock.calls.some(([, options]) => Array.isArray(options) && options.some(
    (option: { range?: { start?: { line?: number } } }) => option.range?.start?.line === line
  ));
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve; rejectPromise = reject;
  });
  return { promise, resolve: (value: T) => resolvePromise?.(value), reject: (reason: unknown) => rejectPromise?.(reason) };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushTurns(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for editor ownership state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
