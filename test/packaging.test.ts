import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { listFiles } from '@vscode/vsce';

const read = (path: string): string => readFileSync(path, 'utf8');
const manifest = JSON.parse(read('package.json')) as { readonly scripts?: { readonly package?: string } };
const packageLock = JSON.parse(read('package-lock.json')) as {
  readonly name?: string;
  readonly packages?: { readonly '': { readonly name?: string } };
};

describe('release package contract', () => {
  it('keeps the package-lock root identity in sync with the extension ID', () => {
    expect(packageLock.name).toBe('what-did-i-write');
    expect(packageLock.packages?.['']?.name).toBe('what-did-i-write');
  });

  it('documents local-only operation and its primary user workflow', () => {
    const readme = read('README.md');

    expect(readme).toContain('What Did I Write?');
    expect(readme).toContain('Find the files, lines, and commits you authored.');
    expect(readme).toContain('what-did-i-write-0.1.0.vsix');
    expect(readme).toContain('local Git');
    expect(readme).toContain('MY CODE');
    expect(readme).toContain('`A`');
    expect(readme).toContain('`M`');
    expect(readme).toContain('`◷`');
    expect(readme).toContain('What Did I Write?: Refresh');
    expect(readme).toContain('Expand All');
    expect(readme).toContain('Hide My Code Decorations');
    expect(readme).toContain('Extension Development Host');
  });

  it('has release notes and excludes development-only content from the VSIX', () => {
    expect(read('CHANGELOG.md')).toContain('0.1.0');
    expect(read('LICENSE')).toContain('No license is granted');
    expect(manifest.scripts?.package).toContain('--allow-missing-repository');

    const ignored = read('.vscodeignore');
    expect(ignored).toContain('src/**');
    expect(ignored).toContain('test/**');
    expect(ignored).toContain('docs/**');
    expect(ignored).toContain('.superpowers/**');
    expect(ignored).toContain('**/*.map');
    expect(ignored).toContain('PROJECT_GOAL.md');
    expect(ignored).toContain('vitest.config.mts');
  });

  it('includes the Activity Bar and both gutter SVG assets in the actual VSIX file list', async () => {
    const files = await listFiles({ cwd: process.cwd() });

    expect(files).toEqual(expect.arrayContaining([
      'media/my-code.svg', 'media/owned-committed.svg', 'media/owned-working.svg',
      'package.nls.json', 'package.nls.ko.json',
      'l10n/bundle.l10n.json', 'l10n/bundle.l10n.ko.json'
    ]));
  });
});
