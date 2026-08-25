import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('separate-runtime Extension Host smoke harness', () => {
  it('pins test-electron and exposes a reproducible smoke command', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly scripts?: { readonly 'test:extension-host'?: string };
      readonly devDependencies?: { readonly '@vscode/test-electron'?: string };
    };

    expect(manifest.devDependencies?.['@vscode/test-electron']).toBe('3.1.0');
    expect(manifest.scripts?.['test:extension-host']).toBe('node test/extensionHost/runSmoke.cjs');
    expect(existsSync('test/extensionHost/runSmoke.cjs')).toBe(true);
    expect(existsSync('test/extensionHost/smokeSuite.cjs')).toBe(true);
    expect(readFileSync('.gitignore', 'utf8')).toContain('.vscode-test');
  });
});
