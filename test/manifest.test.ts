import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly name?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly main?: string;
  readonly type?: string;
  readonly extensionKind?: readonly string[];
  readonly activationEvents?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly { readonly command: string; readonly title: string; readonly icon?: string }[];
    readonly menus?: {
      readonly 'view/item'?: readonly { readonly command: string; readonly when: string }[];
      readonly 'view/title'?: readonly { readonly command: string; readonly when: string; readonly group?: string }[];
    };
    readonly viewsContainers?: {
      readonly activitybar?: readonly { readonly id: string; readonly title: string; readonly icon: string }[];
    };
    readonly colors?: readonly { readonly id: string; readonly defaults: Record<string, string> }[];
    readonly configuration?: {
      readonly title?: string;
      readonly properties?: Record<string, { readonly type: string; readonly default: boolean }>;
    };
    readonly views?: Record<string, readonly { readonly id: string; readonly name: string; readonly type?: string; readonly visibility?: string }[]>;
    readonly viewsWelcome?: readonly { readonly view: string; readonly contents: string }[];
  };
};

describe('extension manifest', () => {
  it('uses the What Did I Write package branding and tagline', () => {
    expect(manifest.name).toBe('what-did-i-write');
    expect(manifest.displayName).toBe('What Did I Write?');
    expect(manifest.description).toBe('Find the files, lines, and commits you authored.');
  });
  it('activates in a workspace with the packaged CommonJS entry point', () => {
    expect(manifest.main).toBe('./dist/extension.js');
    expect(manifest.type).toBe('commonjs');
    expect(manifest.extensionKind).toContain('workspace');
    expect(manifest.activationEvents).toContain('onStartupFinished');
  });

  it('contributes the extension lifecycle commands', () => {
    const commands = manifest.contributes?.commands ?? [];
    expect(commands.map(({ command }) => command)).toEqual(expect.arrayContaining([
      'myCode.refresh',
      'myCode.showOutput',
      'myCode.retryIdentity',
      'myCode.openFile',
      'myCode.focusFileHistory',
      'myCode.focusLineHistory',
      'myCode.showFileHistory',
      'myCode.showLineHistory'
    ]));
    expect(commands.map(({ command }) => command)).not.toEqual(expect.arrayContaining([
      'myCode.openCommitDiff',
      'myCode.openWorkingTreeDiff'
    ]));

  });

  it('contributes MY CODE as its own Activity Bar destination', () => {
    expect(manifest.contributes?.viewsContainers?.activitybar).toEqual(expect.arrayContaining([
      { id: 'myCode', title: 'MY CODE', icon: 'media/my-code.svg' }
    ]));
    expect(manifest.contributes?.views?.myCode).toEqual(expect.arrayContaining([
      { id: 'myCode.explorer', name: 'MY CHANGES' },
      { id: 'myCode.pastActivity', name: 'PAST ACTIVITY', visibility: 'collapsed' },
      { id: 'myCode.history', name: 'FILE HISTORY', type: 'webview' }
    ]));
    expect(manifest.contributes?.views?.explorer).toBeUndefined();
  });

  it('keeps the MY CODE settings namespace while exposing the visual toggle', () => {
    expect(manifest.contributes?.configuration?.title).toBe('What Did I Write?');
    expect(manifest.contributes?.configuration?.properties?.['myCode.visuals.enabled']).toEqual(expect.objectContaining({
      type: 'boolean',
      default: true
    }));
  });

  it('keeps line-background setting, command, and theme color compatibility IDs', () => {
    expect(manifest.contributes?.configuration?.properties)
      .toHaveProperty('myCode.editor.lineBackground');
    expect(manifest.contributes?.commands?.map(({ command }) => command))
      .toContain('myCode.toggleLineBackground');
    expect(manifest.contributes?.colors?.map(({ id }) => id)).toEqual(expect.arrayContaining([
      'myCode.editor.committedLineBackground',
      'myCode.editor.workingLineBackground'
    ]));
  });

  it('explains the file-first workflow when the MY CODE view is empty', () => {
    expect(manifest.contributes?.viewsWelcome).toEqual(expect.arrayContaining([
      expect.objectContaining({
        view: 'myCode.explorer',
        contents: expect.stringContaining('changed files')
      })
    ]));
  });

  it('exposes the core actions in the MY CODE view title bar', () => {
    expect(manifest.contributes?.menus?.['view/title']).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'myCode.refresh', when: 'view == myCode.explorer' }),
      expect.objectContaining({ command: 'myCode.expandAll', when: 'view == myCode.explorer && !myCode.treeAllExpanded' }),
      expect.objectContaining({ command: 'myCode.collapseAll', when: 'view == myCode.explorer && myCode.treeAllExpanded' }),
      expect.objectContaining({ command: 'myCode.hideDecorations', when: 'view == myCode.explorer && myCode.visualsEnabled' })
    ]));
    const commands = manifest.contributes?.commands ?? [];
    expect(commands.filter(({ command }) => command.startsWith('myCode.')).every(({ icon }) => icon !== undefined)).toBe(true);
  });

  it('routes file history from current and past MY CODE tree items', () => {
    expect(manifest.contributes?.menus?.['view/item']).toEqual(expect.arrayContaining([
      { command: 'myCode.showFileHistory', when: 'view == myCode.explorer && viewItem == myCode.file' },
      { command: 'myCode.showFileHistory', when: 'view == myCode.pastActivity && viewItem == myCode.pastFile' }
    ]));
  });

  it('contributes every approved Explorer action with What Did I Write? palette branding and an icon', () => {
    const commands = manifest.contributes?.commands ?? [];
    const required = ['expandAll', 'collapseAll', 'hideDecorations', 'showDecorations', 'openToSide', 'revealInExplorer', 'revealInOs', 'copyPath', 'copyRelativePath', 'copyHistoricalPath', 'copyHistoricalRelativePath', 'cut', 'copy', 'paste', 'newFile', 'newFolder', 'rename', 'delete'].map((id) => `myCode.${id}`);
    expect(commands.map(({ command }) => command)).toEqual(expect.arrayContaining(required));
    for (const command of commands.filter(({ command }) => command.startsWith('myCode.'))) {
      expect(command.title).toMatch(/^What Did I Write\?: /);
      expect(command.icon).toBeTruthy();
    }
  });

  it('uses conditional title slots and exposes mutations only on current non-synthetic rows', () => {
    const title = manifest.contributes?.menus?.['view/title'] ?? [];
    expect(title).toEqual(expect.arrayContaining([
      { command: 'myCode.expandAll', when: 'view == myCode.explorer && !myCode.treeAllExpanded', group: 'navigation@2' },
      { command: 'myCode.collapseAll', when: 'view == myCode.explorer && myCode.treeAllExpanded', group: 'navigation@2' },
      { command: 'myCode.hideDecorations', when: 'view == myCode.explorer && myCode.visualsEnabled', group: 'navigation@3' },
      { command: 'myCode.showDecorations', when: 'view == myCode.explorer && !myCode.visualsEnabled', group: 'navigation@3' }
    ]));
    const items = manifest.contributes?.menus?.['view/item'] ?? [];
    const commandsFor = (contextValue: string) => items.filter(({ when }) => when.includes('viewItem == ' + contextValue)).map(({ command }) => command);
    expect(commandsFor('myCode.file')).toEqual(expect.arrayContaining(['myCode.openFile', 'myCode.openToSide', 'myCode.showFileHistory', 'myCode.revealInExplorer', 'myCode.revealInOs', 'myCode.copyPath', 'myCode.copyRelativePath', 'myCode.cut', 'myCode.copy', 'myCode.paste', 'myCode.rename', 'myCode.delete']));
    expect(commandsFor('myCode.folder')).toEqual(expect.arrayContaining(['myCode.revealInExplorer', 'myCode.revealInOs', 'myCode.copyPath', 'myCode.copyRelativePath', 'myCode.newFile', 'myCode.newFolder', 'myCode.cut', 'myCode.copy', 'myCode.paste', 'myCode.rename', 'myCode.delete']));
    expect(commandsFor('myCode.repository')).toEqual(expect.arrayContaining(['myCode.revealInExplorer', 'myCode.revealInOs', 'myCode.copyPath', 'myCode.copyRelativePath', 'myCode.newFile', 'myCode.newFolder', 'myCode.cut', 'myCode.copy', 'myCode.paste']));
    expect(commandsFor('myCode.repository')).not.toEqual(expect.arrayContaining(['myCode.rename', 'myCode.delete']));
    expect(items.filter(({ when }) => when.includes('viewItem == myCode.pastFile'))).toEqual([
      { command: 'myCode.showFileHistory', when: 'view == myCode.pastActivity && viewItem == myCode.pastFile' },
      { command: 'myCode.copyHistoricalPath', when: 'view == myCode.pastActivity && viewItem == myCode.pastFile' },
      { command: 'myCode.copyHistoricalRelativePath', when: 'view == myCode.pastActivity && viewItem == myCode.pastFile' }
    ]);
});
});
