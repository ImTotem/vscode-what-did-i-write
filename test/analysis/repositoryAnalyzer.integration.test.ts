import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CacheStore } from '../../src/analysis/cacheStore.js';
import {
  RepositoryAnalyzer,
  type RepositoryAccess
} from '../../src/analysis/repositoryAnalyzer.js';
import type {
  CommitSummary,
  FileKind,
  FileRecord,
  GitIdentity
} from '../../src/core/model.js';
import { GitCommandError } from '../../src/git/gitRunner.js';
import type { BlameLine, WorkingChange } from '../../src/git/parsers.js';
import { GitRepository, type UserIndex } from '../../src/git/repository.js';
import { createGitFixture, type GitFixture } from '../helpers/gitFixture.js';

const alice: GitIdentity = { name: 'Alice', email: 'alice@example.com' };
const fixtures: GitFixture[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...fixtures.splice(0).map(async (fixture) => fixture.cleanup()),
    ...temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true }))
  ]);
});

describe('RepositoryAnalyzer', () => {
  it('classifies surviving, overwritten, reverted, working, and untracked user code', async () => {
    const fixture = await createClassificationScenario();
    const storagePath = await createTemporaryDirectory();
    const repository = await GitRepository.discover(fixture.root, fixture.runner);
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));
    const published = [] as ReturnType<RepositoryAnalyzer['getSnapshot']>[];
    analyzer.onDidChange((snapshot) => published.push(snapshot));

    await analyzer.initialize();
    expect(published[0]).toMatchObject({ scanning: true });
    expect(published[0]?.files.map((file) => file.relativePath)).toEqual(expect.arrayContaining([
      'mine-added.ts',
      'mine-survives.ts',
      'mine-overwritten.ts',
      'mine-reverted.ts',
      'working.ts',
      'new-untracked.ts'
    ]));
    await Promise.all([
      'mine-added.ts',
      'mine-survives.ts',
      'mine-overwritten.ts',
      'mine-reverted.ts',
      'working.ts',
      'new-untracked.ts'
    ].map(async (path) => analyzer.ensureFile(path, 'active-editor')));

    const find = (path: string): FileRecord | undefined => analyzer.getFile(path);
    const kind = (path: string): FileKind | undefined => find(path)?.kind;
    expect(kind('mine-added.ts')).toBe('added');
    expect(kind('mine-survives.ts')).toBe('modified');
    expect(kind('mine-overwritten.ts')).toBe('past');
    expect(kind('mine-reverted.ts')).toBe('past');
    expect(find('other-only.ts')).toBeUndefined();
    expect(kind('working.ts')).toBe('modified');
    expect(kind('new-untracked.ts')).toBe('added');
    expect(find('mine-survives.ts')?.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ commit: expect.objectContaining({ authorEmail: 'me@example.com' }) })
    ]));
    expect(find('working.ts')?.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ uncommitted: true })
    ]));
    expect(find('new-untracked.ts')?.ranges).toEqual([
      expect.objectContaining({ start: 0, uncommitted: true })
    ]);
  });

  it('reuses the metadata index by normalized identity and invalidates only what changed', async () => {
    const fixture = await createCacheScenario();
    const storagePath = await createTemporaryDirectory();
    const delegate = await GitRepository.discover(fixture.root, fixture.runner);
    const calls = { logScans: 0, blamedPaths: [] as string[] };
    const repository = new RecordingRepository(delegate, calls);
    const cacheStore = new CacheStore(storagePath);

    const first = new RepositoryAnalyzer(repository, cacheStore);
    await first.initialize();
    await first.ensureFile('cached.ts', 'active-editor');
    await first.ensureFile('unaffected.ts', 'active-editor');
    expect(calls.logScans).toBe(1);

    await fixture.run(['config', '--global', 'user.name', ' me ']);
    await fixture.run(['config', '--global', 'user.email', '<ME@example.com>']);
    const second = new RepositoryAnalyzer(repository, cacheStore);
    await second.initialize();
    await second.ensureFile('cached.ts', 'active-editor');
    await second.ensureFile('unaffected.ts', 'active-editor');
    expect(calls.logScans).toBe(1);

    const cacheFiles = await readdir(storagePath);
    expect(cacheFiles).toHaveLength(1);
    const persisted = await readFile(join(storagePath, cacheFiles[0] as string), 'utf8');
    expect(persisted).not.toContain('secret source must not persist');

    await fixture.writeText('head-change.ts', 'export const head = true;\n');
    await fixture.commit('advance head');
    await second.refresh('head');
    expect(calls.logScans).toBe(2);

    await second.ensureFile('cached.ts', 'active-editor');
    await second.ensureFile('unaffected.ts', 'active-editor');
    const cachedBlamesBefore = count(calls.blamedPaths, 'cached.ts');
    const unaffectedBlamesBefore = count(calls.blamedPaths, 'unaffected.ts');
    await fixture.writeText('cached.ts', [
      'export const owner = "mine";',
      'export const secret = "secret source must not persist";',
      'export const working = true;',
      ''
    ].join('\n'));
    await second.refresh('working-tree', ['cached.ts']);
    await second.ensureFile('cached.ts', 'active-editor');
    await second.ensureFile('unaffected.ts', 'active-editor');
    expect(calls.logScans).toBe(2);
    expect(count(calls.blamedPaths, 'cached.ts')).toBeGreaterThan(cachedBlamesBefore);
    expect(count(calls.blamedPaths, 'unaffected.ts')).toBe(unaffectedBlamesBefore);

    await cacheStore.clearRepository(fixture.root);
    expect(await readdir(storagePath)).toEqual([]);
  });

  it('prioritizes active editors while limiting blame work to four jobs', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const paths = Array.from({ length: 6 }, (_, index) => `priority-${index + 1}.ts`);
    await Promise.all(paths.map(async (path) => writeFile(join(root, path), 'owned\n')));
    const releases = new Map(paths.map((path) => [path, deferred<void>()]));
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let completed = 0;
    const repository = new ControlledRepository(root, paths, async (path) => {
      started.push(path);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await releases.get(path)?.promise;
      active -= 1;
      completed += 1;
      return [ownedLine(userCommit)];
    });
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    const urgent = analyzer.ensureFile('priority-6.ts', 'active-editor');
    await waitUntil(() => started.length >= 4);
    releases.get(started[0] as string)?.resolve();
    await waitUntil(() => started.length >= 5 && started.includes('priority-6.ts'));
    for (const release of releases.values()) release.resolve();
    await urgent;
    await waitUntil(() => completed === paths.length);

    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(started[4]).toBe('priority-6.ts');
  });

  it('discards stale blame writes and settles scanning for the current generation', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    await writeFile(join(root, 'stale.ts'), 'current\n');
    const staleBlame = deferred<BlameLine[]>();
    let blameCalls = 0;
    let completedBlames = 0;
    const repository = new ControlledRepository(root, ['stale.ts'], async () => {
      blameCalls += 1;
      const result = blameCalls === 1
        ? await staleBlame.promise
        : [ownedLine(aliceCommit)];
      completedBlames += 1;
      return result;
    });
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    await waitUntil(() => blameCalls === 1);
    await analyzer.refresh('working-tree', ['stale.ts']);
    await analyzer.ensureFile('stale.ts', 'active-editor');
    expect(analyzer.getFile('stale.ts')?.kind).toBe('past');

    staleBlame.resolve([ownedLine(userCommit)]);
    await waitUntil(() => completedBlames === 2);

    expect(analyzer.getFile('stale.ts')?.kind).toBe('past');
    expect(analyzer.getFile('stale.ts')?.ranges).toEqual([]);
    expect(analyzer.getSnapshot().scanning).toBe(false);
  });

  it('marks an expected binary blame failure as binary without owned ranges', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    await writeFile(join(root, 'reported-binary.dat'), Buffer.from([1, 2, 3, 4]));
    const repository = new ControlledRepository(root, ['reported-binary.dat'], async () => {
      throw new GitCommandError(
        ['blame', '--line-porcelain', '--', 'reported-binary.dat'],
        'cannot blame binary file',
        128,
        'exited with code 128'
      );
    });
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    await analyzer.ensureFile('reported-binary.dat', 'active-editor');

    expect(analyzer.getFile('reported-binary.dat')).toMatchObject({
      binary: true,
      ranges: []
    });
  });

  it('settles scanning immediately when the index has no candidate files', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const repository = new ControlledRepository(root, [], async () => []);
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();

    expect(analyzer.getSnapshot()).toMatchObject({ files: [], scanning: false });
  });
});

async function createClassificationScenario(): Promise<GitFixture> {
  const fixture = await createGitFixture();
  fixtures.push(fixture);

  await fixture.setLocalIdentity(alice);
  await fixture.writeText('mine-survives.ts', 'const first = "alice";\nconst second = "shared";\n');
  await fixture.writeText('mine-overwritten.ts', 'export const value = "alice";\n');
  await fixture.writeText('mine-reverted.ts', 'export const value = "alice";\n');
  await fixture.writeText('other-only.ts', 'export const other = true;\n');
  await fixture.writeText('working.ts', 'export const working = "alice";\n');
  await fixture.commit('alice baseline');

  await fixture.setLocalIdentity(fixture.globalIdentity);
  await fixture.writeText('mine-added.ts', 'export const mine = true;\n');
  await fixture.commit('add mine-added');
  await fixture.writeText('mine-survives.ts', 'const first = "alice";\nconst second = "mine";\n');
  await fixture.commit('edit mine-survives');
  await fixture.writeText('mine-overwritten.ts', 'export const value = "mine";\n');
  await fixture.commit('edit mine-overwritten');
  await fixture.writeText('mine-reverted.ts', 'export const value = "mine";\n');
  await fixture.commit('edit mine-reverted');
  const revertedCommit = (await fixture.run(['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();

  await fixture.setLocalIdentity(alice);
  await fixture.run(['revert', '--no-edit', revertedCommit]);
  await fixture.writeText('mine-overwritten.ts', 'export const value = "alice replacement";\n');
  await fixture.commit('replace mine-overwritten');

  await fixture.setLocalIdentity(fixture.globalIdentity);
  await fixture.writeText('working.ts', 'export const working = "current user";\n');
  await fixture.writeText('new-untracked.ts', 'export const untracked = true;\n');
  return fixture;
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'my-code-analyzer-'));
  temporaryDirectories.push(path);
  return path;
}

async function createCacheScenario(): Promise<GitFixture> {
  const fixture = await createGitFixture();
  fixtures.push(fixture);

  await fixture.setLocalIdentity(alice);
  await fixture.writeText('cached.ts', 'export const owner = "alice";\n');
  await fixture.writeText('unaffected.ts', 'export const stable = "alice";\n');
  await fixture.commit('alice cache baseline');
  await fixture.setLocalIdentity(fixture.globalIdentity);
  await fixture.writeText('cached.ts', [
    'export const owner = "mine";',
    'export const secret = "secret source must not persist";',
    ''
  ].join('\n'));
  await fixture.writeText('unaffected.ts', 'export const stable = "mine";\n');
  await fixture.commit('user cache change');
  return fixture;
}

class RecordingRepository implements RepositoryAccess {
  public readonly root: string;

  public constructor(
    private readonly delegate: GitRepository,
    private readonly calls: { logScans: number; blamedPaths: string[] }
  ) {
    this.root = delegate.root;
  }

  public getGlobalIdentity(): Promise<GitIdentity> {
    return this.delegate.getGlobalIdentity();
  }

  public getHead(): Promise<string | undefined> {
    return this.delegate.getHead();
  }

  public async getUserIndex(identity: GitIdentity): Promise<UserIndex> {
    this.calls.logScans += 1;
    return this.delegate.getUserIndex(identity);
  }

  public getWorkingChanges(): Promise<WorkingChange[]> {
    return this.delegate.getWorkingChanges();
  }

  public async blame(path: string): Promise<BlameLine[]> {
    this.calls.blamedPaths.push(path);
    return this.delegate.blame(path);
  }
}

function count(values: readonly string[], value: string): number {
  return values.filter((candidate) => candidate === value).length;
}

const userCommit: CommitSummary = {
  hash: '1'.repeat(40),
  authorName: 'Me',
  authorEmail: 'me@example.com',
  authoredAt: 1_700_000_000,
  subject: 'user change'
};

const aliceCommit: CommitSummary = {
  hash: '2'.repeat(40),
  authorName: 'Alice',
  authorEmail: 'alice@example.com',
  authoredAt: 1_700_000_001,
  subject: 'alice change'
};

class ControlledRepository implements RepositoryAccess {
  public constructor(
    public readonly root: string,
    private readonly paths: readonly string[],
    private readonly runBlame: (path: string) => Promise<BlameLine[]>
  ) {}

  public async getGlobalIdentity(): Promise<GitIdentity> {
    return { name: 'Me', email: 'me@example.com' };
  }

  public async getHead(): Promise<string> {
    return 'a'.repeat(40);
  }

  public async getUserIndex(_identity: GitIdentity): Promise<UserIndex> {
    return {
      commits: [userCommit],
      entries: [{
        commit: userCommit,
        changes: this.paths.map((path) => ({ status: 'M', path }))
      }]
    };
  }

  public async getWorkingChanges(): Promise<WorkingChange[]> {
    return [];
  }

  public blame(path: string): Promise<BlameLine[]> {
    return this.runBlame(path);
  }
}

function ownedLine(commit: CommitSummary): BlameLine {
  return { line: 0, commit, uncommitted: false };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value)
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for analyzer state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
