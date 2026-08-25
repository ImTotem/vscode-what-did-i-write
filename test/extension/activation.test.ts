import { describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  const commandIds: string[] = [];
  const eventRegistrations: string[] = [];
  const treeViewIds: string[] = [];
  const decorationProviders: unknown[] = [];
  const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const disposable = () => ({ dispose: vi.fn() });
  const output = { appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() };
  const status = { text: '', show: vi.fn(), dispose: vi.fn() };
  const showQuickPick = vi.fn<(items: unknown[]) => Promise<unknown>>();
  const executeCommand = vi.fn(async () => undefined);
  class EventEmitter {
    public readonly event = () => disposable();
    public fire(): void {}
    public dispose(): void {}
  }
  return {
    commandIds,
    eventRegistrations,
    treeViewIds,
    decorationProviders,
    commandHandlers,
    showQuickPick,
    executeCommand,
    disposable,
    output,
    status,
    EventEmitter
  };
});

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  commands: {
    registerCommand: (command: string, handler: (...args: unknown[]) => unknown) => {
      mocks.commandHandlers.set(command, handler);
      mocks.commandIds.push(command);
      return mocks.disposable();
    },
    executeCommand: mocks.executeCommand
  },
  EventEmitter: mocks.EventEmitter,
  ThemeColor: class { constructor(public readonly id: string) {} },
  OverviewRulerLane: { Left: 1 },
  window: {
    state: { focused: false },
    visibleTextEditors: [],
    createTextEditorDecorationType: () => mocks.disposable(),
    createOutputChannel: vi.fn(() => mocks.output),
    createStatusBarItem: vi.fn(() => mocks.status),
    showWarningMessage: vi.fn(async () => undefined),
    showQuickPick: mocks.showQuickPick,
    registerFileDecorationProvider: (provider: unknown) => {
      mocks.decorationProviders.push(provider);
      return mocks.disposable();
    },
    registerTreeDataProvider: (viewId: string) => {
      mocks.treeViewIds.push(viewId);
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
    onDidChangeTextDocument: () => registerEvent('document-change'),
    onDidChangeWorkspaceFolders: () => registerEvent('workspace-folders'),
    onDidSaveTextDocument: () => registerEvent('save'),
    onDidCreateFiles: () => registerEvent('create'),
    onDidDeleteFiles: () => registerEvent('delete'),
    onDidRenameFiles: () => registerEvent('rename')
  }
}));

import { activate } from '../../src/extension.js';

describe('extension activation', () => {
  it('registers Explorer commands and shows a selected file\'s inline history', async () => {
    const subscriptions: { dispose(): unknown }[] = [];
    const context = { subscriptions, storageUri: undefined } as unknown as vscode.ExtensionContext;

    expect(activate(context)).toBeUndefined();

    expect(mocks.commandIds).toEqual([
      'myCode.refresh',
      'myCode.showOutput',
      'myCode.retryIdentity',
      'myCode.toggleLineBackground',
      'myCode.openFile',
      'myCode.showFileHistory'
    ]);
    expect(mocks.treeViewIds).toEqual(['myCode.explorer']);
    expect(mocks.decorationProviders).toHaveLength(1);
    expect(mocks.eventRegistrations).toEqual([
      'active-editor',
      'visible-editors',
      'document-change',
      'save',
      'workspace-folders',
      'save',
      'create',
      'delete',
      'rename',
      'window-state'
    ]);
    expect(subscriptions).toHaveLength(22);
    expect(subscriptions).toEqual(expect.arrayContaining([mocks.output, mocks.status]));
    expect(mocks.status.text).toBe('$(sync~spin) My Code: Scanning');
    const showFileHistory = mocks.commandHandlers.get('myCode.showFileHistory');
    if (showFileHistory === undefined) throw new Error('showFileHistory was not registered');
    mocks.showQuickPick.mockImplementationOnce(async (items: unknown[]) => items[0]);
    await showFileHistory({
      kind: 'file',
      root: '/workspace',
      label: 'src/auth.ts',
      children: [],
      file: {
        relativePath: 'src/auth.ts',
        kind: 'modified',
        exists: true,
        working: false,
        binary: false,
        ranges: [],
        history: [{ hash: 'abcdef123456', authorName: 'Me', authorEmail: 'me@example.com', authoredAt: 1, subject: 'Add auth' }]
      }
    });
    expect(mocks.showQuickPick).toHaveBeenCalledWith([expect.objectContaining({ label: 'Add auth', description: 'abcdef1' })], expect.objectContaining({ placeHolder: 'My Code history for src/auth.ts' }));
    expect(mocks.executeCommand).toHaveBeenCalledWith('myCode.openCommitDiff', expect.objectContaining({ kind: 'history', relativePath: 'src/auth.ts', commit: expect.objectContaining({ hash: 'abcdef123456' }) }));
  });
});

function registerEvent(name: string): { dispose(): void } {
  mocks.eventRegistrations.push(name);
  return mocks.disposable();
}
