import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { projectTree } from '../../src/ui/myCodeTree.js';
import type { RepositorySnapshot } from '../../src/core/model.js';

describe('projectTree', () => {
  it('groups one repository into sorted current and past activity files', () => {
    const groups = projectTree([snapshot('/workspace', [
      file('z-last.ts', 'modified'),
      file('old.ts', 'past', false),
      file('a-added.ts', 'added'),
      file('m-middle.ts', 'modified')
    ])]);

    expect(groups.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: 'group', label: 'CURRENT' },
      { kind: 'group', label: 'PAST ACTIVITY' }
    ]);
    expect(groups[0]?.children.map(({ label, badge }) => ({ label, badge }))).toEqual([
      { label: 'a-added.ts', badge: 'A' },
      { label: 'm-middle.ts', badge: 'M' },
      { label: 'z-last.ts', badge: 'M' }
    ]);
    expect(groups[1]?.children.map(({ label, badge }) => ({ label, badge }))).toEqual([
      { label: 'old.ts', badge: '◷' }
    ]);
  });

  it('adds repository roots above groups in a multi-root workspace', () => {
    const repositories = projectTree([
      snapshot('/workspace/api', [file('api.ts', 'modified')]),
      snapshot('/workspace/web', [file('web.ts', 'added')])
    ]);

    expect(repositories.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: 'repository', label: 'api' },
      { kind: 'repository', label: 'web' }
    ]);
    expect(repositories[0]?.children.map(({ label }) => label)).toEqual(['CURRENT', 'PAST ACTIVITY']);
  });
});

function snapshot(root: string, files: RepositorySnapshot['files']): RepositorySnapshot {
  return {
    root,
    head: 'head',
    identity: { name: 'Me', email: 'me@example.com' },
    files,
    scanning: false,
    generatedAt: 1
  };
}

function file(
  relativePath: string,
  kind: 'added' | 'modified' | 'past',
  exists = true
): RepositorySnapshot['files'][number] {
  return {
    relativePath,
    kind,
    exists,
    working: false,
    binary: false,
    ranges: [],
    history: []
  };
}
