import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  const commandIds: string[] = [];
  const eventRegistrations: string[] = [];
  const createdTreeViews: Array<{ viewId: string; options: Record<string, unknown> }> = [];
  const treeDataProviderIds: string[] = [];
  const outputChannelNames: string[] = [];
  const configurationListeners: Array<(event: { affectsConfiguration(section: string): boolean }) => unknown> = [];
  const decorationProviders: unknown[] = [];
  const contentProviderSchemes: string[] = [];
  const webviewViewIds: string[] = [];
  const hoverProviders: Array<{ selector: unknown; provider: unknown }> = [];
  const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const disposable = () => ({ dispose: vi.fn() });
  const output = { appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() };
  const status = { text: '', show: vi.fn(), dispose: vi.fn() };
  const showQuickPick = vi.fn<(items: unknown[]) => Promise<unknown>>();
  const executeCommand = vi.fn(async () => undefined);
  const treeView = {
    selection: [] as unknown[],
    reveal: vi.fn(async () => undefined),
    onDidExpandElement: () => disposable(),
    onDidCollapseElement: () => disposable(),
    dispose: vi.fn()
  };
  class EventEmitter {
    public readonly event = () => disposable();
    public fire(): void {}
    public dispose(): void {}
  }
  return {
    commandIds,
    eventRegistrations,
    createdTreeViews,
    treeDataProviderIds,
    outputChannelNames,
    configurationListeners,
    decorationProviders,
    contentProviderSchemes,
    webviewViewIds,
    hoverProviders,
    commandHandlers,
    showQuickPick,
    executeCommand,
    disposable,
    output,
    status,
    treeView,
    EventEmitter
  };
});

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Workspace: 2 },
  commands: {
    registerCommand: (command: string, handler: (...args: unknown[]) => unknown) => {
      mocks.commandHandlers.set(command, handler);
      mocks.commandIds.push(command);
      return mocks.disposable();
    },
    executeCommand: mocks.executeCommand
  },
  EventEmitter: mocks.EventEmitter,
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
  languages: {
    registerHoverProvider: (selector: unknown, provider: unknown) => {
      mocks.hoverProviders.push({ selector, provider });
      return mocks.disposable();
    }
  },
  ThemeColor: class { constructor(public readonly id: string) {} },
  OverviewRulerLane: { Left: 1 },
  window: {
    state: { focused: false },
    visibleTextEditors: [],
    createTextEditorDecorationType: () => mocks.disposable(),
    createOutputChannel: vi.fn((name: string) => {
      mocks.outputChannelNames.push(name);
      return mocks.output;
    }),
    createStatusBarItem: vi.fn(() => mocks.status),
    showWarningMessage: vi.fn(async () => undefined),
    showQuickPick: mocks.showQuickPick,
    registerFileDecorationProvider: (provider: unknown) => {
      mocks.decorationProviders.push(provider);
      return mocks.disposable();
    },
    createTreeView: (viewId: string, options: Record<string, unknown>) => {
      mocks.createdTreeViews.push({ viewId, options });
      return mocks.treeView;
    },
    registerTreeDataProvider: (viewId: string) => {
      mocks.treeDataProviderIds.push(viewId);
      return mocks.disposable();
    },
    registerWebviewViewProvider: (viewId: string) => {
      mocks.webviewViewIds.push(viewId);
      return mocks.disposable();
    },
    onDidChangeActiveTextEditor: () => registerEvent('active-editor'),
    onDidChangeVisibleTextEditors: () => registerEvent('visible-editors'),
    onDidChangeWindowState: () => {
      mocks.eventRegistrations.push('window-state');
      return mocks.disposable();
    }
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback, update: vi.fn(async () => undefined) }),
    registerTextDocumentContentProvider: (scheme: string) => {
      mocks.contentProviderSchemes.push(scheme);
      return mocks.disposable();
    },
    onDidChangeTextDocument: () => registerEvent('document-change'),
    onDidCloseTextDocument: () => registerEvent('close'),
    onDidChangeWorkspaceFolders: () => registerEvent('workspace-folders'),
    onDidSaveTextDocument: () => registerEvent('save'),
    onDidCreateFiles: () => registerEvent('create'),
    onDidDeleteFiles: () => registerEvent('delete'),
    onDidRenameFiles: () => registerEvent('rename'),
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => unknown) => {
      mocks.configurationListeners.push(listener);
      return registerEvent('configuration');
    }
  }
}));

import { activate } from '../../src/extension.js';
import { RefreshController } from '../../src/ui/refreshController.js';
import { EditorOwnershipController } from '../../src/ui/editorOwnership.js';
import { HistoryTimelineViewProvider } from '../../src/ui/historyTimeline.js';
import { MyCodeFileActions } from '../../src/ui/myCodeFileActions.js';
import { MyCodeTreeProvider, PastActivityTreeProvider } from '../../src/ui/myCodeTree.js';
import { MyCodeViewController, VisualModeController } from '../../src/ui/myCodeViewController.js';

describe('extension activation', () => {
  it('registers Explorer and history commands plus the read-only revision provider', async () => {
    const subscriptions: { dispose(): unknown }[] = [];
    const context = { subscriptions, storageUri: undefined } as unknown as vscode.ExtensionContext;
    const refreshAll = vi.spyOn(RefreshController.prototype, 'refreshAll').mockResolvedValue(undefined);
    const refreshHistory = vi.spyOn(HistoryTimelineViewProvider.prototype, 'refresh').mockResolvedValue(undefined);
    const scheduleHistoryRefresh = vi.spyOn(
      HistoryTimelineViewProvider.prototype,
      'scheduleRegistryRefresh'
    );
    const refreshCurrent = vi.spyOn(MyCodeTreeProvider.prototype, 'refresh').mockResolvedValue(undefined);
    const refreshPast = vi.spyOn(PastActivityTreeProvider.prototype, 'refresh').mockResolvedValue(undefined);
    const resolveNode = vi.spyOn(MyCodeTreeProvider.prototype, 'resolveNode');
    const resolvePastNode = vi.spyOn(PastActivityTreeProvider.prototype, 'resolveNode');
    const focusHistory = vi.spyOn(HistoryTimelineViewProvider.prototype, 'focus').mockResolvedValue(undefined);
    const rename = vi.spyOn(MyCodeFileActions.prototype, 'rename').mockResolvedValue(undefined);
    const expandAll = vi.spyOn(MyCodeViewController.prototype, 'expandAll').mockResolvedValue(undefined);
    const collapseAll = vi.spyOn(MyCodeViewController.prototype, 'collapseAll').mockResolvedValue(undefined);
    const toggleVisuals = vi.spyOn(VisualModeController.prototype, 'toggle').mockResolvedValue(undefined);
    const acceptVisualConfiguration = vi.spyOn(VisualModeController.prototype, 'acceptConfigurationChange').mockResolvedValue(undefined);
    const acceptBackgroundConfiguration = vi.spyOn(
      EditorOwnershipController.prototype,
      'acceptLineBackgroundConfigurationChange'
    ).mockResolvedValue(undefined);

    expect(activate(context)).toBeUndefined();

    expect(mocks.commandIds).toEqual(expect.arrayContaining([
      'myCode.refresh',
      'myCode.showOutput',
      'myCode.retryIdentity',
      'myCode.toggleLineBackground',
      'myCode.openFile',
      'myCode.focusFileHistory',
      'myCode.focusLineHistory',
      'myCode.showFileHistory',
      'myCode.showLineHistory',
      'myCode.openCommitDiff',
      'myCode.openWorkingTreeDiff',
      'myCode.expandAll',
      'myCode.collapseAll',
      'myCode.hideDecorations',
      'myCode.showDecorations',
      'myCode.openToSide',
      'myCode.revealInExplorer',
      'myCode.revealInOs',
      'myCode.copyPath',
      'myCode.copyRelativePath',
      'myCode.copyHistoricalPath',
      'myCode.copyHistoricalRelativePath',
      'myCode.cut',
      'myCode.copy',
      'myCode.paste',
      'myCode.newFile',
      'myCode.newFolder',
      'myCode.rename',
      'myCode.delete'
    ]));
    expect(mocks.createdTreeViews).toHaveLength(1);
    expect(mocks.createdTreeViews[0]?.viewId).toBe('myCode.explorer');
    expect(mocks.createdTreeViews[0]?.options).toMatchObject({ canSelectMany: true });
    expect(mocks.createdTreeViews[0]?.options.dragAndDropController).toBeDefined();
    expect(mocks.createdTreeViews[0]?.options.treeDataProvider).toBeDefined();
    expect(mocks.treeDataProviderIds).toEqual(['myCode.pastActivity']);
    expect(mocks.webviewViewIds).toEqual(['myCode.history']);
    expect(mocks.decorationProviders).toHaveLength(1);
    expect(mocks.contentProviderSchemes).toEqual(['my-code-git']);
    expect(mocks.eventRegistrations.filter((name) => name === 'active-editor')).toHaveLength(2);
    expect(mocks.eventRegistrations).toEqual(expect.arrayContaining([
      'visible-editors', 'document-change', 'workspace-folders', 'create', 'delete', 'rename', 'configuration', 'window-state'
    ]));
    expect(subscriptions.length).toBeGreaterThanOrEqual(40);
    expect(mocks.hoverProviders).toHaveLength(0);
    expect(subscriptions).toEqual(expect.arrayContaining([mocks.output, mocks.status]));
    expect(mocks.outputChannelNames).toEqual(['What Did I Write?']);
    expect(mocks.status.text).toBe('$(sync~spin) What Did I Write?: Scanning');

    const focusFileHandler = mocks.commandHandlers.get('myCode.focusFileHistory');
    const focusLineHandler = mocks.commandHandlers.get('myCode.focusLineHistory');
    await Promise.resolve(focusFileHandler?.('/repo/source.ts'));
    await Promise.resolve(focusLineHandler?.('/repo/source.ts', 4));
    expect(mocks.executeCommand).toHaveBeenCalledWith('myCode.history.focus');

    focusHistory.mockClear();
    const stalePast = { id: '["past","/repo","deleted/stale.ts"]', kind: 'past', root: '/stale', relativePath: 'stale.ts' };
    const freshPast = { ...stalePast, root: '/repo', relativePath: 'deleted/fresh.ts' };
    resolvePastNode.mockReturnValue(freshPast as never);
    await Promise.resolve(mocks.commandHandlers.get('myCode.showFileHistory')?.(stalePast));
    expect(resolvePastNode).toHaveBeenCalledWith(stalePast.id);
    expect(focusHistory).toHaveBeenCalledWith(join('/repo', 'deleted/fresh.ts'), undefined);

    focusHistory.mockClear();
    resolvePastNode.mockReturnValue(undefined);
    const staleHistoryFile = { id: '["file","/repo","stale-history.ts"]', kind: 'file' };
    const freshHistoryFile = {
      id: staleHistoryFile.id,
      kind: 'file',
      root: '/repo',
      file: { relativePath: 'fresh-history.ts' }
    };
    resolveNode.mockReturnValue(freshHistoryFile as never);
    await Promise.resolve(mocks.commandHandlers.get('myCode.showFileHistory')?.(staleHistoryFile));
    expect(resolveNode).toHaveBeenCalledWith(staleHistoryFile.id);
    expect(focusHistory).toHaveBeenCalledWith(freshHistoryFile, undefined);

    await Promise.resolve(mocks.commandHandlers.get('myCode.expandAll')?.());
    await Promise.resolve(mocks.commandHandlers.get('myCode.collapseAll')?.());
    await Promise.resolve(mocks.commandHandlers.get('myCode.hideDecorations')?.());
    expect(expandAll).toHaveBeenCalledTimes(1);
    expect(collapseAll).toHaveBeenCalledTimes(1);
    expect(toggleVisuals).toHaveBeenCalledTimes(1);

    expect(mocks.configurationListeners).toHaveLength(1);
    await Promise.resolve(mocks.configurationListeners[0]?.({
      affectsConfiguration: (section) => section === 'myCode.visuals.enabled'
    }));
    expect(acceptVisualConfiguration).toHaveBeenCalledTimes(1);
    await Promise.resolve(mocks.configurationListeners[0]?.({
      affectsConfiguration: (section) => section === 'myCode.editor.lineBackground'
    }));
    expect(acceptBackgroundConfiguration).toHaveBeenCalledTimes(1);

    const stale = { id: '["file","repo","stale.ts"]' };
    const fresh = { id: stale.id, kind: 'file', root: '/repo', file: { relativePath: 'fresh.ts' } };
    resolveNode.mockReturnValue(fresh as never);
    await Promise.resolve(mocks.commandHandlers.get('myCode.rename')?.(stale));
    expect(rename).toHaveBeenCalledWith(fresh);

    await flushActivation();
    expect(scheduleHistoryRefresh).toHaveBeenCalled();
    expect(refreshHistory).not.toHaveBeenCalled();
    refreshAll.mockClear();
    scheduleHistoryRefresh.mockClear();
    refreshHistory.mockClear();
    refreshCurrent.mockClear();
    refreshPast.mockClear();
    const refreshHandler = mocks.commandHandlers.get('myCode.refresh');
    await Promise.resolve(refreshHandler?.());
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(refreshHistory).toHaveBeenCalledTimes(1);
    expect(refreshCurrent).toHaveBeenCalledTimes(1);
    expect(refreshPast).toHaveBeenCalledTimes(1);
    expect(refreshAll.mock.invocationCallOrder[0]).toBeLessThan(
      refreshHistory.mock.invocationCallOrder[0] as number
    );
    refreshAll.mockRestore();
    scheduleHistoryRefresh.mockRestore();
    refreshHistory.mockRestore();

    const commitDiffHandler = mocks.commandHandlers.get('myCode.openCommitDiff');
    const workingDiffHandler = mocks.commandHandlers.get('myCode.openWorkingTreeDiff');
    await expect(
      Promise.resolve(commitDiffHandler?.())
    ).resolves.toBeUndefined();
    await expect(Promise.resolve(workingDiffHandler?.())).resolves.toBeUndefined();
    refreshCurrent.mockRestore();
    refreshPast.mockRestore();
    resolveNode.mockRestore();
    resolvePastNode.mockRestore();
    focusHistory.mockRestore();
    rename.mockRestore();
    expandAll.mockRestore();
    collapseAll.mockRestore();
    toggleVisuals.mockRestore();
    acceptVisualConfiguration.mockRestore();
    acceptBackgroundConfiguration.mockRestore();
  });
});

function registerEvent(name: string): { dispose(): void } {
  mocks.eventRegistrations.push(name);
  return mocks.disposable();
}

async function flushActivation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
