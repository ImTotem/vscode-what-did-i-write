import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class EventEmitter<T> {
    public readonly event = () => ({ dispose: () => undefined });
    public fire(_value: T): void {}
    public dispose(): void {}
  }
  return { EventEmitter };
});

vi.mock('vscode', () => ({ EventEmitter: mocks.EventEmitter, env: { language: 'en' }, l10n: { t: (message: string) => message } }));

import {
  MyCodeTreeProvider,
  projectCurrentTree,
  projectPastActivity,
  projectTree
} from '../../src/ui/myCodeTree.js';
import * as treeModule from '../../src/ui/myCodeTree.js';
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
  it('expands overlapping folder and file selections into unique file nodes', () => {
    const roots = projectCurrentTree([snapshot('/workspace', [
      file('src/a.ts', 'modified'), file('src/nested/b.ts', 'added'), file('other.ts', 'modified')
    ])]);
    const src = roots.find(({ label }) => label === 'src');
    const nestedFile = src?.children[0]?.children[0];
    const selectFiles = (treeModule as unknown as {
      fileNodesForSelection?: (nodes: readonly unknown[]) => readonly { readonly file: { readonly relativePath: string } }[];
    }).fileNodesForSelection;

    expect(selectFiles).toBeTypeOf('function');
    expect(selectFiles?.([src, nestedFile].filter((node) => node !== undefined))
      .map(({ file: selected }) => selected.relativePath)).toEqual([
        'src/a.ts', 'src/nested/b.ts'
      ]);
  });

  it('shows single-repository current roots directly without a CURRENT group', () => {
    const roots = projectCurrentTree([snapshot('/workspace', [
      file('z-last.ts', 'modified'), file('old.ts', 'past', false), file('a-added.ts', 'added')
    ])]);

    expect(roots.map(({ id, kind, label, badge }) => ({ id, kind, label, badge }))).toEqual([
      { id: '["file","/workspace","a-added.ts"]', kind: 'file', label: 'a-added.ts', badge: 'A' },
      { id: '["file","/workspace","z-last.ts"]', kind: 'file', label: 'z-last.ts', badge: 'M' }
    ]);
  });

  it('keeps sorted repository roots for multiple repositories', () => {
    const roots = projectCurrentTree([
      snapshot('/workspace/web', [file('web.ts', 'added')]),
      snapshot('/workspace/api', [file('api.ts', 'modified')])
    ]);

    expect(roots.map(({ id, kind, label }) => ({ id, kind, label }))).toEqual([
      { id: '["repository","/workspace/api",""]', kind: 'repository', label: 'api' },
      { id: '["repository","/workspace/web",""]', kind: 'repository', label: 'web' }
    ]);
  });

  it('keeps delimiter-shaped multi-root file IDs and resolve targets distinct', () => {
    const firstSnapshot = snapshot('/w/a', [file('b|c.ts', 'modified')]);
    const secondSnapshot = snapshot('/w/a|b', [file('c.ts', 'modified')]);
    const registry = {
      repositories: [
        { root: firstSnapshot.root, state: 'ready', analyzer: { getSnapshot: () => firstSnapshot } },
        { root: secondSnapshot.root, state: 'ready', analyzer: { getSnapshot: () => secondSnapshot } }
      ],
      onDidChange: () => ({ dispose: () => undefined })
    };
    const provider = new MyCodeTreeProvider(registry as never);
    const roots = provider.getChildren();
    const first = roots.find((node) => node.kind === 'repository' && node.root === '/w/a')?.children[0];
    const second = roots.find((node) => node.kind === 'repository' && node.root === '/w/a|b')?.children[0];
    if (first?.kind !== 'file' || second?.kind !== 'file') throw new Error('file nodes missing');

    expect(first.id).not.toBe(second.id);
    expect(provider.resolveNode(first.id)).toMatchObject({
      root: '/w/a',
      file: { relativePath: 'b|c.ts' }
    });
    expect(provider.resolveNode(second.id)).toMatchObject({
      root: '/w/a|b',
      file: { relativePath: 'c.ts' }
    });
    provider.dispose();
  });

  it('returns flat newest-first past rows with parent paths and stable IDs', () => {
    const rows = projectPastActivity([snapshot('/workspace', [
      { ...file('src/old.ts', 'past', false), history: [commit(10, 'older'), commit(30, 'newest')] },
      { ...file('middle.ts', 'past'), history: [commit(20, 'middle')] }, file('current.ts', 'modified')
    ])]);

    expect(rows.map(({ id, label, parentPath, latestCommit }) => ({ id, label, parentPath, timestamp: latestCommit?.authoredAt }))).toEqual([
      { id: '["past","/workspace","src/old.ts"]', label: 'old.ts', parentPath: 'src', timestamp: 30 },
      { id: '["past","/workspace","middle.ts"]', label: 'middle.ts', parentPath: '.', timestamp: 20 }
    ]);
  });
});

function commit(authoredAt: number, hash: string): CommitSummary {
  return { hash, authorName: 'Me', authorEmail: 'me@example.com', authoredAt, subject: hash };
}
