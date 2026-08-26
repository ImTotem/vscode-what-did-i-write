import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('README accuracy', () => {
  it('documents the renamed extension and exact public tagline', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toContain('# What Did I Write?');
    expect(readme).toContain('Find the files, lines, and commits you authored.');
    expect(readme).toContain('what-did-i-write-0.1.0.vsix');
    expect(readme).toContain('What Did I Write?');
    expect(readme).toContain('output channel');
  });
  it('requires an explicit refresh after a global identity change', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toContain('not detected by repository fingerprint polling');
    expect(readme).toContain('`What Did I Write?: Retry` or `What Did I Write?: Refresh`');
  });

  it('documents the gutter-to-timeline workflow instead of the retired history picker', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toContain('FILE HISTORY');
    expect(readme).toContain('newest commit at the top');
    expect(readme).toContain('gutter marker');
    expect(readme).toContain('reusable preview diff');
    expect(readme).toContain('folder hierarchy');
    expect(readme).not.toContain('History picker');
    expect(readme).not.toContain('three most recent');
  });

  it('does not call a required live Extension Host verification optional', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toContain('When the `code` executable is installed, live Extension Host activation and');
    expect(readme).toContain('registration of `myCode.refresh` are required release gates');
    expect(readme).toContain('that gate remains incomplete');
  });
});
