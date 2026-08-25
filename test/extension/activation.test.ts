import { describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  const commandIds: string[] = [];
  const eventRegistrations: string[] = [];
  const disposable = () => ({ dispose: vi.fn() });
  const output = { appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() };
  const status = { text: '', show: vi.fn(), dispose: vi.fn() };
  return { commandIds, eventRegistrations, disposable, output, status };
});

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  commands: {
    registerCommand: (command: string) => {
      mocks.commandIds.push(command);
      return mocks.disposable();
    }
  },
  window: {
    state: { focused: false },
    createOutputChannel: vi.fn(() => mocks.output),
    createStatusBarItem: vi.fn(() => mocks.status),
    showWarningMessage: vi.fn(async () => undefined),
    onDidChangeWindowState: () => {
      mocks.eventRegistrations.push('window-state');
      return mocks.disposable();
    }
  },
  workspace: {
    workspaceFolders: [],
    onDidChangeWorkspaceFolders: () => registerEvent('workspace-folders'),
    onDidSaveTextDocument: () => registerEvent('save'),
    onDidCreateFiles: () => registerEvent('create'),
    onDidDeleteFiles: () => registerEvent('delete'),
    onDidRenameFiles: () => registerEvent('rename')
  }
}));

import { activate } from '../../src/extension.js';

describe('extension activation', () => {
  it('returns synchronously with commands, events, and owned disposables registered', () => {
    const subscriptions: { dispose(): unknown }[] = [];
    const context = { subscriptions, storageUri: undefined } as unknown as vscode.ExtensionContext;

    expect(activate(context)).toBeUndefined();

    expect(mocks.commandIds).toEqual([
      'myCode.refresh',
      'myCode.showOutput',
      'myCode.retryIdentity'
    ]);
    expect(mocks.eventRegistrations).toEqual([
      'workspace-folders',
      'save',
      'create',
      'delete',
      'rename',
      'window-state'
    ]);
    expect(subscriptions).toHaveLength(14);
    expect(subscriptions).toEqual(expect.arrayContaining([mocks.output, mocks.status]));
    expect(mocks.status.text).toBe('$(sync~spin) My Code: Scanning');
  });
});

function registerEvent(name: string): { dispose(): void } {
  mocks.eventRegistrations.push(name);
  return mocks.disposable();
}
