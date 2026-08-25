import * as vscode from 'vscode';

import { CacheStore } from './analysis/cacheStore.js';
import { RepositoryRegistry, type RegistryOperation } from './extension/repositoryRegistry.js';
import { GitCommandError } from './git/gitRunner.js';
import { MyCodeDecorationProvider } from './ui/fileDecorations.js';
import { EditorOwnershipController } from './ui/editorOwnership.js';
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
    vscode.commands.registerCommand('myCode.refresh', () => refreshController.refreshAll()),
    vscode.commands.registerCommand('myCode.showOutput', () => output.show()),
    vscode.commands.registerCommand('myCode.retryIdentity', () => refreshController.retryIdentity()),
    vscode.commands.registerCommand('myCode.toggleLineBackground', () => editorOwnership.toggleLineBackground()),
    vscode.commands.registerCommand('myCode.openFile', (node: MyCodeNode) => openFile(node)),
    vscode.commands.registerCommand('myCode.showFileHistory', (node: MyCodeNode) => showFileHistory(node)),
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

interface FileHistoryItem extends vscode.QuickPickItem {
  readonly node: Extract<MyCodeNode, { readonly kind: 'history' }>;
}

async function showFileHistory(node: MyCodeNode): Promise<void> {
  if (node.kind !== 'file') return;
  const items: FileHistoryItem[] = node.file.history.map((commit) => ({
    label: commit.subject,
    description: commit.hash.slice(0, 7),
    detail: `${commit.authorName} <${commit.authorEmail}> — ${new Date(commit.authoredAt * 1_000).toLocaleString()}`,
    node: {
      kind: 'history',
      root: node.root,
      relativePath: node.file.relativePath,
      commit,
      label: commit.subject,
      children: []
    }
  }));
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `My Code history for ${node.file.relativePath}`
  });
  if (selected !== undefined) await vscode.commands.executeCommand('myCode.openCommitDiff', selected.node);
}

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
