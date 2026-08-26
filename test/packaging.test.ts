import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');
const manifest = JSON.parse(read('package.json')) as { readonly scripts?: { readonly package?: string } };

describe('release package contract', () => {
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
    expect(readme).toContain('My Code: Refresh');
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
});
