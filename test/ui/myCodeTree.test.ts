import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { projectCurrentTree, projectPastActivity, projectTree } from '../../src/ui/myCodeTree.js';
import type { CommitSummary, RepositorySnapshot } from '../../src/core/model.js';

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

  it('projects nested paths as folders-first Explorer nodes with leaf files', () => {
    const groups = projectTree([snapshot('/workspace', [
      file('host/LGHyperVProbe/a.cpp', 'modified'),
      file('host/LGHyperVProbe/tests/b.cpp', 'added'),
      file('root.cpp', 'modified')
    ])]);
    const current = groups[0];
    const host = current?.children[0];
    const probe = host?.children[0];

    expect(host).toMatchObject({ kind: 'folder', label: 'host' });
    expect(probe).toMatchObject({ kind: 'folder', label: 'LGHyperVProbe' });
    expect(probe?.children.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: 'folder', label: 'tests' },
      { kind: 'file', label: 'a.cpp' }
    ]);
    expect(probe?.children[1]?.children).toEqual([]);
    expect(current?.children[1]).toMatchObject({ kind: 'file', label: 'root.cpp', children: [] });
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
    expect(repositories[0]?.children.map(({ label }) => label)).toEqual(['CURRENT']);
  });

  it('keeps repository roots when only one multi-root repository has My Code files', () => {
    const repositories = projectTree([
      snapshot('/workspace/api', []),
      snapshot('/workspace/web', [file('web.ts', 'added')])
    ]);

    expect(repositories.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: 'repository', label: 'web' }
    ]);
    expect(repositories[0]?.children.map(({ label }) => label)).toEqual(['CURRENT']);
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

describe('current and past projections', () => {
  it('shows single-repository current roots directly without a CURRENT group', () => {
    const roots = projectCurrentTree([snapshot('/workspace', [
      file('z-last.ts', 'modified'), file('old.ts', 'past', false), file('a-added.ts', 'added')
    ])]);

    expect(roots.map(({ id, kind, label, badge }) => ({ id, kind, label, badge }))).toEqual([
      { id: 'file|/workspace|a-added.ts', kind: 'file', label: 'a-added.ts', badge: 'A' },
      { id: 'file|/workspace|z-last.ts', kind: 'file', label: 'z-last.ts', badge: 'M' }
    ]);
  });

  it('keeps sorted repository roots for multiple repositories', () => {
    const roots = projectCurrentTree([
      snapshot('/workspace/web', [file('web.ts', 'added')]),
      snapshot('/workspace/api', [file('api.ts', 'modified')])
    ]);

    expect(roots.map(({ id, kind, label }) => ({ id, kind, label }))).toEqual([
      { id: 'repository|/workspace/api', kind: 'repository', label: 'api' },
      { id: 'repository|/workspace/web', kind: 'repository', label: 'web' }
    ]);
  });

  it('returns flat newest-first past rows with parent paths and stable IDs', () => {
    const rows = projectPastActivity([snapshot('/workspace', [
      { ...file('src/old.ts', 'past', false), history: [commit(10, 'older'), commit(30, 'newest')] },
      { ...file('middle.ts', 'past'), history: [commit(20, 'middle')] }, file('current.ts', 'modified')
    ])]);

    expect(rows.map(({ id, label, parentPath, latestCommit }) => ({ id, label, parentPath, timestamp: latestCommit?.authoredAt }))).toEqual([
      { id: 'past|/workspace|src/old.ts', label: 'old.ts', parentPath: 'src', timestamp: 30 },
      { id: 'past|/workspace|middle.ts', label: 'middle.ts', parentPath: '.', timestamp: 20 }
    ]);
  });
});

function commit(authoredAt: number, hash: string): CommitSummary {
  return { hash, authorName: 'Me', authorEmail: 'me@example.com', authoredAt, subject: hash };
}