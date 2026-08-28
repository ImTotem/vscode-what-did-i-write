import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const englishMessages = JSON.parse(readFileSync('package.nls.json', 'utf8')) as Readonly<Record<string, string>>;

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly name?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly main?: string;
  readonly type?: string;
  readonly extensionKind?: readonly string[];
  readonly activationEvents?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly { readonly command: string; readonly title: string; readonly category?: string; readonly icon?: string }[];
    readonly menus?: {
      readonly 'view/item/context'?: readonly { readonly command: string; readonly when: string; readonly group?: string }[];
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
function english(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^%([^%]+)%$/.exec(value);
  return match === null ? value : englishMessages[match[1] as string];
}


describe('extension manifest', () => {
  it('uses the What Did I Write package branding and tagline', () => {
    expect(manifest.name).toBe('what-did-i-write');
    expect(english(manifest.displayName)).toBe('What Did I Write?');
    expect(english(manifest.description)).toBe('Find the files, lines, and commits you authored.');
  });
  it('activates in a workspace with the packaged CommonJS entry point', () => {
    expect(manifest.main).toBe('./dist/extension.js');
    expect(manifest.type).toBe('commonjs');
    expect(manifest.extensionKind).toContain('workspace');
    expect(manifest.activationEvents).toContain('onStartupFinished');
  });

  it('contributes the extension lifecycle commands', () => {
    const commands = manifest.contributes?.commands ?? [];
    expect(commands.map(({ command }) => command)).not.toContain('myCode.expandAll');
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
    const activitybar = manifest.contributes?.viewsContainers?.activitybar ?? [];
    expect(activitybar.map((item) => ({ ...item, title: english(item.title) }))).toEqual(expect.arrayContaining([
      { id: 'myCode', title: 'MY CODE', icon: 'media/my-code.svg' }
    ]));
    const views = manifest.contributes?.views?.myCode ?? [];
    expect(views.map((item) => ({ ...item, name: english(item.name) }))).toEqual(expect.arrayContaining([
      { id: 'myCode.explorer', name: 'MY CHANGES' },
      { id: 'myCode.pastActivity', name: 'PAST ACTIVITY', visibility: 'collapsed' },
      { id: 'myCode.history', name: 'FILE HISTORY', type: 'webview' }
    ]));
    expect(manifest.contributes?.views?.explorer).toBeUndefined();
  });

  it('keeps the MY CODE settings namespace while exposing the visual toggle', () => {
    expect(english(manifest.contributes?.configuration?.title)).toBe('What Did I Write?');
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
        contents: expect.any(String)
      })
    ]));
    expect(english(manifest.contributes?.viewsWelcome?.[0]?.contents)).toContain('changed files');
  });

  it('exposes the core actions in the MY CODE view title bar', () => {
    expect(manifest.contributes?.menus?.['view/title']).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'myCode.refresh', when: 'view == myCode.explorer' }),
      expect.objectContaining({ command: 'myCode.collapseAll', when: 'view == myCode.explorer' }),
      expect.objectContaining({ command: 'myCode.hideDecorations', when: 'view == myCode.explorer && myCode.visualsEnabled' }),
      expect.objectContaining({ command: 'myCode.toggleLineBackground', when: 'view == myCode.explorer' })
    ]));
    const commands = manifest.contributes?.commands ?? [];
    expect(commands.filter(({ command }) => command.startsWith('myCode.')).every(({ icon }) => icon !== undefined)).toBe(true);
  });

  it('routes file history from current and past MY CODE tree items', () => {
    expect(manifest.contributes?.menus?.['view/item/context']).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'myCode.showFileHistory', when: 'view == myCode.explorer && viewItem == myCode.file' }),
      expect.objectContaining({ command: 'myCode.showFileHistory', when: 'view == myCode.pastActivity && viewItem == myCode.pastFile' })
    ]));
  });

  it('uses short tooltip labels while keeping Command Palette branding in the category', () => {
    const commands = manifest.contributes?.commands ?? [];
    const required = ['collapseAll', 'hideDecorations', 'showDecorations', 'openToSide', 'revealInExplorer', 'revealInOs', 'copyPath', 'copyRelativePath', 'copyHistoricalPath', 'copyHistoricalRelativePath', 'cut', 'copy', 'paste', 'newFile', 'newFolder', 'rename', 'delete'].map((id) => `myCode.${id}`);
    expect(commands.map(({ command }) => command)).toEqual(expect.arrayContaining(required));
    for (const command of commands.filter(({ command }) => command.startsWith('myCode.'))) {
      expect(english(command.title)).not.toMatch(/^What Did I Write\?: /);
      expect(english(command.title)).toBeTruthy();
      expect(english(command.category)).toBe('What Did I Write?');
      expect(command.icon).toBeTruthy();
    }
  });

  it('groups context actions like Explorer and exposes compact row-hover icons', () => {
    const items = manifest.contributes?.menus?.['view/item/context'] ?? [];
    const find = (command: string, contextValue: string, group: string) => items.find((item) =>
      item.command === command
      && item.when.includes(`viewItem == ${contextValue}`)
      && item.group === group
    );

    expect(find('myCode.openFile', 'myCode.file', 'navigation@1')).toBeDefined();
    expect(find('myCode.showFileHistory', 'myCode.file', '3_history@1')).toBeDefined();
    expect(find('myCode.cut', 'myCode.file', '5_cutcopypaste@1')).toBeDefined();
    expect(find('myCode.copyPath', 'myCode.file', '6_copypath@1')).toBeDefined();
    expect(find('myCode.rename', 'myCode.file', '7_modification@1')).toBeDefined();

    expect(find('myCode.openFile', 'myCode.file', 'inline@1')).toBeDefined();
    expect(find('myCode.openToSide', 'myCode.file', 'inline@2')).toBeDefined();
    expect(find('myCode.showFileHistory', 'myCode.file', 'inline@3')).toBeDefined();
    expect(find('myCode.newFile', 'myCode.folder', 'inline@1')).toBeDefined();
    expect(find('myCode.newFolder', 'myCode.folder', 'inline@2')).toBeDefined();
    expect(find('myCode.newFile', 'myCode.repository', 'inline@1')).toBeDefined();
    expect(find('myCode.newFolder', 'myCode.repository', 'inline@2')).toBeDefined();
  });

  it('uses conditional title slots and exposes mutations only on current non-synthetic rows', () => {
    const title = manifest.contributes?.menus?.['view/title'] ?? [];
    expect(title).toEqual(expect.arrayContaining([
      { command: 'myCode.collapseAll', when: 'view == myCode.explorer', group: 'navigation@2' },
      { command: 'myCode.hideDecorations', when: 'view == myCode.explorer && myCode.visualsEnabled', group: 'navigation@3' },
      { command: 'myCode.showDecorations', when: 'view == myCode.explorer && !myCode.visualsEnabled', group: 'navigation@3' },
      { command: 'myCode.toggleLineBackground', when: 'view == myCode.explorer', group: 'navigation@4' }
    ]));
    const items = manifest.contributes?.menus?.['view/item/context'] ?? [];
    const commandsFor = (contextValue: string) => items.filter(({ when }) => when.includes('viewItem == ' + contextValue)).map(({ command }) => command);
    expect(commandsFor('myCode.file')).toEqual(expect.arrayContaining(['myCode.openFile', 'myCode.openToSide', 'myCode.showFileHistory', 'myCode.revealInExplorer', 'myCode.revealInOs', 'myCode.copyPath', 'myCode.copyRelativePath', 'myCode.cut', 'myCode.copy', 'myCode.paste', 'myCode.rename', 'myCode.delete']));
    expect(commandsFor('myCode.folder')).toEqual(expect.arrayContaining(['myCode.revealInExplorer', 'myCode.revealInOs', 'myCode.copyPath', 'myCode.copyRelativePath', 'myCode.newFile', 'myCode.newFolder', 'myCode.cut', 'myCode.copy', 'myCode.paste', 'myCode.rename', 'myCode.delete']));
    expect(commandsFor('myCode.repository')).toEqual(expect.arrayContaining(['myCode.revealInExplorer', 'myCode.revealInOs', 'myCode.copyPath', 'myCode.copyRelativePath', 'myCode.newFile', 'myCode.newFolder', 'myCode.cut', 'myCode.copy', 'myCode.paste']));
    expect(commandsFor('myCode.repository')).not.toEqual(expect.arrayContaining(['myCode.rename', 'myCode.delete']));
    expect(items.filter(({ when }) => when.includes('viewItem == myCode.pastFile'))).toEqual([
      { command: 'myCode.showFileHistory', when: 'view == myCode.pastActivity && viewItem == myCode.pastFile', group: 'navigation@1' },
      { command: 'myCode.copyHistoricalPath', when: 'view == myCode.pastActivity && viewItem == myCode.pastFile', group: '6_copypath@1' },
      { command: 'myCode.copyHistoricalRelativePath', when: 'view == myCode.pastActivity && viewItem == myCode.pastFile', group: '6_copypath@2' }
    ]);
  });
});
