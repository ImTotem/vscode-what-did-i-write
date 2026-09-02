import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('README accuracy', () => {
  it('documents the renamed extension and exact public tagline', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toContain('# What Did I Write?');
    expect(readme).toContain('Find the files, lines, and commits you authored.');
    expect(readme).toContain('what-did-i-write-0.2.2.vsix');
    expect(readme).toContain('What Did I Write?');
    expect(readme).toContain('output channel');
  });

  it('credits Codex vibe coding at the top of every localized README', () => {
    const root = readFileSync('README.md', 'utf8');
    const english = readFileSync('docs/README.en.md', 'utf8');
    const korean = readFileSync('docs/README.ko.md', 'utf8');

    expect(root.split(/\r?\n/)[0]).toBe('<sub>Built entirely through vibe coding with Codex.</sub>');
    expect(english.split(/\r?\n/)[0]).toBe('<sub>Built entirely through vibe coding with Codex.</sub>');
    expect(korean.split(/\r?\n/)[0]).toBe(
      '<sub>이 프로젝트는 Codex를 사용한 풀 바이브 코딩으로 제작되었습니다.</sub>'
    );
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
    expect(readme).toContain('native Quick Diff');
    expect(readme).toContain('expands on hover');
    expect(readme).toContain('click it to open VS Code\'s native inline diff');
    expect(readme).not.toContain('compact ownership card');
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
