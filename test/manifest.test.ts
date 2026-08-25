import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly main?: string;
  readonly type?: string;
  readonly extensionKind?: readonly string[];
  readonly activationEvents?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly { readonly command: string; readonly title: string }[];
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
      'myCode.retryIdentity'
    ]));
  });
});
