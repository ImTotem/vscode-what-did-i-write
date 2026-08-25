import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('README accuracy', () => {
  it('requires an explicit refresh after a global identity change', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toContain('not detected by repository fingerprint polling');
    expect(readme).toContain('My Code: Retry or My Code: Refresh');
  });

  it('does not call a required live Extension Host verification optional', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toContain('When the `code` executable is installed, live Extension Host activation and');
    expect(readme).toContain('registration of `myCode.refresh` are required release gates');
    expect(readme).toContain('that gate remains incomplete');
  });
});
