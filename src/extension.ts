import { join } from 'node:path';

import * as vscode from 'vscode';

import { CacheStore } from './analysis/cacheStore.js';
import { RepositoryRegistry, type RegistryOperation } from './extension/repositoryRegistry.js';
import { GitCommandError } from './git/gitRunner.js';
import { localize } from './localization.js';
import { MyCodeDecorationProvider } from './ui/fileDecorations.js';
import { EditorOwnershipController } from './ui/editorOwnership.js';
import { GIT_CONTENT_SCHEME, GitContentProvider } from './ui/gitContentProvider.js';
import { HistoryController } from './ui/historyController.js';
import { HistoryTimelineViewProvider } from './ui/historyTimeline.js';
import { MyCodeDragAndDropController } from './ui/myCodeDragAndDrop.js';
import { MyCodeFileActions } from './ui/myCodeFileActions.js';
import { MyCodeTreeProvider, PastActivityTreeProvider, type MyCodeNode, type PastActivityNode } from './ui/myCodeTree.js';
import { MyCodeViewController, VisualModeController } from './ui/myCodeViewController.js';
import { OWNERSHIP_ORIGINAL_SCHEME, OwnershipQuickDiffController } from './ui/ownershipQuickDiff.js';
import { RefreshController } from './ui/refreshController.js';
import { StatusController } from './ui/statusController.js';

let activeVisualModeController: VisualModeController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('What Did I Write?');
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  let statusController: StatusController | undefined;
  const reportError = (error: unknown, operation: string, path: string): void => {
    output.appendLine(`[${new Date().toISOString()}] ${operation} (${path}): ${errorMessage(error)}`);
    if (isMissingGit(error)) statusController?.reportMissingGit(error);
  };
  const cacheStore = new CacheStore(context.storageUri);
  const registry = RepositoryRegistry.create(
    () => (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri),
    cacheStore,
    (error: unknown, operation: RegistryOperation, path: string) => reportError(error, operation, path)
  );
  const refreshController = new RefreshController(registry, { onError: reportError });
  const decorationProvider = new MyCodeDecorationProvider(registry, reportError);
  const treeProvider = new MyCodeTreeProvider(registry);
  const pastActivityProvider = new PastActivityTreeProvider(registry);
  const editorOwnership = new EditorOwnershipController(
    registry,
    { onError: reportError },
    context.workspaceState
  );
  const gitContentProvider = new GitContentProvider(registry, reportError);
  const historyController = new HistoryController(registry);
  const historyTimeline = new HistoryTimelineViewProvider(historyController, reportError);
  const ownershipQuickDiff = new OwnershipQuickDiffController(
    registry,
    editorOwnership,
    reportError
  );
  const withMyCodeProgress = <T>(task: () => Promise<T>): Promise<T> =>
    Promise.resolve(vscode.window.withProgress(
      { location: { viewId: 'myCode.explorer' } },
      () => task()
    ));
  let fullRefreshes = 0;
  const refreshAllViews = (): Promise<void> => withMyCodeProgress(async () => {
    fullRefreshes += 1;
    try {
      await refreshController.refreshAll();
      await historyTimeline.refresh();
      await treeProvider.refresh();
      await pastActivityProvider.refresh();
    } finally {
      fullRefreshes -= 1;
    }
  });
  let myChangesView: vscode.TreeView<MyCodeNode>;
  const fileActions = new MyCodeFileActions({
    selection: () => myChangesView.selection,
    roots: () => registry.repositories.map(({ root }) => root),
    refresh: refreshAllViews,
    onError: reportError,
    localize
  });
  const dragAndDropController = new MyCodeDragAndDropController(treeProvider, fileActions);
  myChangesView = vscode.window.createTreeView<MyCodeNode>('myCode.explorer', {
    treeDataProvider: treeProvider,
    canSelectMany: true,
    dragAndDropController
  });
  const viewController = new MyCodeViewController();
  const visualModeController = new VisualModeController(
    decorationProvider,
    editorOwnership,
    context.workspaceState,
    ownershipQuickDiff,
    (error) => reportError(error, 'restore-scm-decorations', 'scm.diffDecorations')
  );
  activeVisualModeController = visualModeController;
  statusController = new StatusController(registry, statusItem, {
    showWarning: (message, ...actions) => vscode.window.showWarningMessage(message, ...actions),
    showOutput: () => output.show(),
    retryIdentity: () => refreshController.retryIdentity(),
    localize
  });
  const refreshFingerprintsWhenFocused = (): Promise<void> =>
    vscode.window.state.focused ? refreshController.tick() : Promise.resolve();

  const runHistoryCommand = (
    operation: string, target: unknown, action: () => Promise<void>
  ): Promise<void> => Promise.resolve()
    .then(action)
    .catch((error: unknown) => reportError(error, operation, commandTargetPath(target)));
  const focusHistory = async (target: unknown, line?: number): Promise<void> => {
    await historyTimeline.focus(target, line);
    await vscode.commands.executeCommand('myCode.history.focus');
  };
  const currentNode = (target: unknown): MyCodeNode | undefined => {
    if (typeof target !== 'object' || target === null || !('id' in target)) return undefined;
    const id = (target as { readonly id?: unknown }).id;
    return typeof id === 'string' ? treeProvider.resolveNode(id) : undefined;
  };
  const pastNode = (target: unknown): PastActivityNode | undefined => {
    if (typeof target !== 'object' || target === null || !('id' in target)) return undefined;
    const id = (target as { readonly id?: unknown }).id;
    return typeof id === 'string' ? pastActivityProvider.resolveNode(id) : undefined;
  };
  const withCurrentNode = async (
    target: unknown,
    action: (node: MyCodeNode) => Promise<void>
  ): Promise<void> => {
    const node = currentNode(target);
    if (node === undefined) {
      await vscode.window.showWarningMessage(localize('That MY CHANGES item is no longer available. Refresh and try again.'));
      return;
    }
    await action(node);
  };
  const withPastNode = async (
    target: unknown,
    action: (node: PastActivityNode) => Promise<void>
  ): Promise<void> => {
    const node = pastNode(target);
    if (node === undefined) {
      await vscode.window.showWarningMessage(localize('That PAST ACTIVITY item is no longer available. Refresh and try again.'));
      return;
    }
    await action(node);
  };
  const withHistoryTarget = async (
    target: unknown,
    action: (resolved: unknown) => Promise<void>
  ): Promise<void> => {
    if (typeof target !== 'object' || target === null || !('id' in target)) {
      await action(target);
      return;
    }
    const id = (target as { readonly id?: unknown }).id;
    if (typeof id !== 'string') {
      await action(target);
      return;
    }
    const historical = pastActivityProvider.resolveNode(id);
    if (historical !== undefined) {
      await action(join(historical.root, historical.relativePath));
      return;
    }
    const current = treeProvider.resolveNode(id);
    if (current !== undefined) {
      await action(current);
      return;
    }
    await vscode.window.showWarningMessage(localize('That history item is no longer available. Refresh and try again.'));
  };
  const runUiCommand = async (operation: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      reportError(error, operation, 'myCode.explorer');
      await vscode.window.showErrorMessage(localize(
        'Could not {operation}. See the What Did I Write? output for details.',
        { operation: localize(operation) }
      ));
    }
  };

  context.subscriptions.push(
    output,
    statusItem,
    registry,
    refreshController,
    statusController,
    decorationProvider,
    treeProvider,
    pastActivityProvider,
    editorOwnership,
    ownershipQuickDiff,
    historyTimeline,
    myChangesView,
    viewController,
    registry.onDidChange(() => historyTimeline.scheduleRegistryRefresh(
      fullRefreshes > 0 || registry.repositories.some(({ analyzer }) =>
        analyzer.getSnapshot().scanning
      )
    )),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.window.registerTreeDataProvider('myCode.pastActivity', pastActivityProvider),
    vscode.window.registerWebviewViewProvider('myCode.history', historyTimeline, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.workspace.registerTextDocumentContentProvider(GIT_CONTENT_SCHEME, gitContentProvider),
    vscode.workspace.registerTextDocumentContentProvider(
      OWNERSHIP_ORIGINAL_SCHEME, ownershipQuickDiff
    ),
    vscode.commands.registerCommand('myCode.refresh', refreshAllViews),
    vscode.commands.registerCommand('myCode.showOutput', () => output.show()),
    vscode.commands.registerCommand('myCode.retryIdentity', () => refreshController.retryIdentity()),
    vscode.commands.registerCommand('myCode.toggleLineBackground', () => editorOwnership.toggleLineBackground()),
    vscode.commands.registerCommand('myCode.collapseAll', () =>
      runUiCommand('collapse MY CHANGES', () => viewController.collapseAll())),
    vscode.commands.registerCommand('myCode.hideDecorations', () =>
      runUiCommand('hide decorations', () => visualModeController.setEnabled(false))),
    vscode.commands.registerCommand('myCode.showDecorations', () =>
      runUiCommand('show decorations', () => visualModeController.setEnabled(true))),
    vscode.commands.registerCommand('myCode.openFile', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.open(node))),
    vscode.commands.registerCommand('myCode.openToSide', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.openToSide(node))),
    vscode.commands.registerCommand('myCode.revealInExplorer', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.revealInExplorer(node))),
    vscode.commands.registerCommand('myCode.revealInOs', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.revealInOs(node))),
    vscode.commands.registerCommand('myCode.copyPath', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.copyPath(node))),
    vscode.commands.registerCommand('myCode.copyRelativePath', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.copyRelativePath(node))),
    vscode.commands.registerCommand('myCode.copyHistoricalPath', (target: unknown) =>
      withPastNode(target, (node) => fileActions.copyPath(node))),
    vscode.commands.registerCommand('myCode.copyHistoricalRelativePath', (target: unknown) =>
      withPastNode(target, (node) => fileActions.copyRelativePath(node))),
    vscode.commands.registerCommand('myCode.cut', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.cut(node))),
    vscode.commands.registerCommand('myCode.copy', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.copy(node))),
    vscode.commands.registerCommand('myCode.paste', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.paste(node))),
    vscode.commands.registerCommand('myCode.newFile', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.newFile(node))),
    vscode.commands.registerCommand('myCode.newFolder', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.newFolder(node))),
    vscode.commands.registerCommand('myCode.rename', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.rename(node))),
    vscode.commands.registerCommand('myCode.delete', (target: unknown) =>
      withCurrentNode(target, (node) => fileActions.delete(node))),
    vscode.commands.registerCommand('myCode.focusFileHistory', (target?: unknown) =>
      runHistoryCommand('file-history', target, () => focusHistory(target))),
    vscode.commands.registerCommand('myCode.focusLineHistory', (target?: unknown, line?: number) =>
      runHistoryCommand('line-history', target, () => focusHistory(
        target,
        line ?? vscode.window.activeTextEditor?.selection.active.line
      ))),
    vscode.commands.registerCommand('myCode.showFileHistory', (target?: unknown) =>
      runHistoryCommand('file-history', target, () =>
        withHistoryTarget(target, (resolved) => focusHistory(resolved)))),
    vscode.commands.registerCommand('myCode.showLineHistory', (target?: unknown, line?: number) =>
      runHistoryCommand('line-history', target, () => focusHistory(
        target,
        line ?? vscode.window.activeTextEditor?.selection.active.line
      ))),
    vscode.commands.registerCommand('myCode.openCommitDiff', (
      target?: Parameters<HistoryController['openCommitDiff']>[0]
    ) => target === undefined ? undefined : runHistoryCommand(
      'commit-diff', target, () => historyController.openCommitDiff(target)
    )),
    vscode.commands.registerCommand('myCode.openWorkingTreeDiff', (
      target?: Parameters<HistoryController['openWorkingTreeDiff']>[0]
    ) => target === undefined ? undefined : runHistoryCommand(
      'working-tree-diff', target, () => historyController.openWorkingTreeDiff(target)
    )),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void registry
        .updateWorkspaceFolders((vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri))
        .then(refreshFingerprintsWhenFocused)
        .catch((error: unknown) => reportError(error, 'workspace-folders', 'workspace'));
    }),
    vscode.workspace.onDidSaveTextDocument(({ uri }) => refreshController.acceptSave(uri)),
    vscode.workspace.onDidCreateFiles(({ files }) => refreshController.acceptCreate(files)),
    vscode.workspace.onDidDeleteFiles(({ files }) => refreshController.acceptDelete(files)),
    vscode.workspace.onDidRenameFiles(({ files }) => refreshController.acceptRename(files)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('myCode.visuals.enabled')) {
        void runUiCommand('update visual settings', () => visualModeController.acceptConfigurationChange());
      }
      if (event.affectsConfiguration('myCode.editor.lineBackground')) {
        void runUiCommand(
          'update line background',
          () => editorOwnership.acceptLineBackgroundConfigurationChange()
        );
      }
    }),
    vscode.window.onDidChangeWindowState(({ focused }) => refreshController.setFocused(focused)),
    vscode.window.onDidChangeActiveTextEditor((editor) => historyTimeline.followEditor(editor))
  );

  refreshController.setFocused(vscode.window.state.focused);
  historyTimeline.followEditor(vscode.window.activeTextEditor);
  void withMyCodeProgress(async () => {
    await registry.start();
    await refreshFingerprintsWhenFocused();
  })
    .catch((error: unknown) => reportError(error, 'start', 'workspace'));
}

export async function deactivate(): Promise<void> {
  const controller = activeVisualModeController;
  activeVisualModeController = undefined;
  await controller?.shutdown();
}


function isMissingGit(error: unknown): boolean {
  return error instanceof GitCommandError
    && error.exitCode === null
    && /(?:ENOENT|not found|cannot find)/i.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandTargetPath(target: unknown): string {
  if (typeof target !== 'object' || target === null) return 'active-editor';
  const candidate = target as {
    readonly relativePath?: unknown;
    readonly workingPath?: unknown;
    readonly path?: unknown;
    readonly file?: { readonly relativePath?: unknown };
  };
  for (const path of [candidate.relativePath, candidate.workingPath, candidate.path, candidate.file?.relativePath]) {
    if (typeof path === 'string' && path.length > 0) return path;
  }
  return 'active-editor';
}
