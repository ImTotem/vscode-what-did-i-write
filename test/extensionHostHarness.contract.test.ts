import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

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
  it('requires every contributed command plus internal history diff commands', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly contributes?: { readonly commands?: ReadonlyArray<{ readonly command: string }> };
    };
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(readFileSync('test/extensionHost/smokeSuite.cjs', 'utf8'), {
      module,
      exports: module.exports,
      require: (id: string) => id === 'vscode' ? {} : createRequire(resolve('test/extensionHostHarness.contract.test.ts'))(id)
    });
    const smoke = module.exports as {
      requiredCommandIds(packageJson: typeof manifest): readonly string[];
    };
    const contributed = (manifest.contributes?.commands ?? []).map(({ command }) => command);

    expect(smoke.requiredCommandIds(manifest)).toEqual([
      ...contributed,
      'myCode.openCommitDiff',
      'myCode.openWorkingTreeDiff'
    ]);
  });
});
