import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly main?: string;
  readonly type?: string;
  readonly extensionKind?: readonly string[];
  readonly activationEvents?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly { readonly command: string; readonly title: string }[];
    readonly menus?: { readonly 'view/item'?: readonly { readonly command: string; readonly when: string }[] };
    readonly views?: { readonly explorer?: readonly { readonly id: string; readonly name: string }[] };
  };
};

describe('extension manifest', () => {
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
      'myCode.showFileHistory'
    ]));
  });

  it('contributes the MY CODE Explorer view', () => {
    expect(manifest.contributes?.views?.explorer).toEqual(expect.arrayContaining([
      { id: 'myCode.explorer', name: 'MY CODE' }
    ]));
  });

  it('routes file history from current and past MY CODE tree items', () => {
    expect(manifest.contributes?.menus?.['view/item']).toEqual(expect.arrayContaining([
      { command: 'myCode.showFileHistory', when: 'view == myCode.explorer && viewItem == myCode.file' },
      { command: 'myCode.showFileHistory', when: 'view == myCode.explorer && viewItem == myCode.pastFile' }
    ]));
  });
});
