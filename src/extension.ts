import * as vscode from 'vscode';

import { CacheStore } from './analysis/cacheStore.js';
import { RepositoryRegistry, type RegistryOperation } from './extension/repositoryRegistry.js';
import { GitCommandError } from './git/gitRunner.js';
import { MyCodeDecorationProvider } from './ui/fileDecorations.js';
import { EditorOwnershipController } from './ui/editorOwnership.js';
import { GIT_CONTENT_SCHEME, GitContentProvider } from './ui/gitContentProvider.js';
import { HistoryController } from './ui/historyController.js';
import { fileUri, MyCodeTreeProvider, type MyCodeNode } from './ui/myCodeTree.js';
import { RefreshController } from './ui/refreshController.js';
import { StatusController } from './ui/statusController.js';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('My Code');
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
  const decorationProvider = new MyCodeDecorationProvider(registry);
  const treeProvider = new MyCodeTreeProvider(registry);
  const editorOwnership = new EditorOwnershipController(registry);
  const gitContentProvider = new GitContentProvider(registry);
  const historyController = new HistoryController(registry);
  statusController = new StatusController(registry, statusItem, {
    showWarning: (message, ...actions) => vscode.window.showWarningMessage(message, ...actions),
    showOutput: () => output.show(),
    retryIdentity: () => refreshController.retryIdentity()
  });
  const refreshFingerprintsWhenFocused = (): Promise<void> =>
    vscode.window.state.focused ? refreshController.tick() : Promise.resolve();

  context.subscriptions.push(
    output,
    statusItem,
    registry,
    refreshController,
    statusController,
    decorationProvider,
    treeProvider,
    editorOwnership,
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.window.registerTreeDataProvider('myCode.explorer', treeProvider),
    vscode.workspace.registerTextDocumentContentProvider(GIT_CONTENT_SCHEME, gitContentProvider),
    vscode.commands.registerCommand('myCode.refresh', () => refreshController.refreshAll()),
    vscode.commands.registerCommand('myCode.showOutput', () => output.show()),
    vscode.commands.registerCommand('myCode.retryIdentity', () => refreshController.retryIdentity()),
    vscode.commands.registerCommand('myCode.toggleLineBackground', () => editorOwnership.toggleLineBackground()),
    vscode.commands.registerCommand('myCode.openFile', (node: MyCodeNode) => openFile(node)),
    vscode.commands.registerCommand('myCode.showFileHistory', (target?: unknown) => historyController.showFileHistory(target)),
    vscode.commands.registerCommand('myCode.showLineHistory', (target?: unknown, line?: number) => historyController.showLineHistory(target, line)),
    vscode.commands.registerCommand('myCode.openCommitDiff', (target) => historyController.openCommitDiff(target)),
    vscode.commands.registerCommand('myCode.openWorkingTreeDiff', (target) => historyController.openWorkingTreeDiff(target)),
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
    vscode.window.onDidChangeWindowState(({ focused }) => refreshController.setFocused(focused))
  );

  refreshController.setFocused(vscode.window.state.focused);
  void registry
    .start()
    .then(refreshFingerprintsWhenFocused)
    .catch((error: unknown) => reportError(error, 'start', 'workspace'));
}

export function deactivate(): void {}

function openFile(node: MyCodeNode): Thenable<unknown> | undefined {
  if (node.kind !== 'file' || !node.file.exists) return undefined;
  return vscode.commands.executeCommand('vscode.open', fileUri(node));
}

function isMissingGit(error: unknown): boolean {
  return error instanceof GitCommandError
    && error.exitCode === null
    && /(?:ENOENT|not found|cannot find)/i.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
