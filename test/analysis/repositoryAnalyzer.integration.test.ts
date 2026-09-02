import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CacheStore,
  hashRepositoryRoot,
  type CachedRepositoryIndex,
  type CacheIndexKey
} from '../../src/analysis/cacheStore.js';
import {
  RepositoryAnalyzer,
  type RepositoryAccess
} from '../../src/analysis/repositoryAnalyzer.js';
import type {
  CommitSummary,
  FileKind,
  FileRecord,
  GitIdentity,
  RepositorySnapshot
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
  it('publishes an empty paused analysis without reading work or scheduling blame when identity is missing', async () => {
    const root = await createTemporaryDirectory();
    await writeFile(join(root, 'paused.ts'), 'working only\n');
    const calls = { index: 0, working: 0, blame: 0 };
    const repository: RepositoryAccess = {
      root,
      getGlobalIdentity: async () => ({ name: '  ', email: '' }),
      getHead: async () => 'a'.repeat(40),
      getUserIndex: async () => {
        calls.index += 1;
        return indexForPaths(['paused.ts']);
      },
      getWorkingChanges: async () => {
        calls.working += 1;
        return [{ status: '?', path: 'paused.ts' }];
      },
      blame: async () => {
        calls.blame += 1;
        return [ownedLine(userCommit)];
      }
    };
    const analyzer = new RepositoryAnalyzer(
      repository,
      new CacheStore(await createTemporaryDirectory())
    );

    await analyzer.initialize();

    expect(analyzer.getSnapshot()).toMatchObject({
      identity: { name: '  ', email: '' },
      files: [],
      scanning: false
    });
    await expect(analyzer.ensureFile('paused.ts', 'active-editor')).resolves.toBeUndefined();
    expect(calls).toEqual({ index: 0, working: 0, blame: 0 });
  });

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
      'mine-binary.dat',
      'mine-deleted.ts',
      'mine-survives.ts',
      'mine-overwritten.ts',
      'mine-reverted.ts',
      'working.ts',
      'new-untracked.ts'
    ]));
    await Promise.all([
      'mine-added.ts',
      'mine-binary.dat',
      'mine-deleted.ts',
      'mine-survives.ts',
      'mine-overwritten.ts',
      'mine-reverted.ts',
      'working.ts',
      'new-untracked.ts'
    ].map(async (path) => analyzer.ensureFile(path, 'active-editor')));

    const find = (path: string): FileRecord | undefined => analyzer.getFile(path);
    const kind = (path: string): FileKind | undefined => find(path)?.kind;
    expect(kind('mine-added.ts')).toBe('added');
    expect(find('mine-binary.dat')).toMatchObject({
      kind: 'added',
      binary: true,
      ranges: []
    });
    expect(find('mine-deleted.ts')).toMatchObject({ kind: 'past', exists: false });
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

  it('keeps an author candidate on its current path after another author renames it', async () => {
    const fixture = await createGitFixture();
    fixtures.push(fixture);
    const originalPath = 'src/original # [한글].ts';
    const renamedPath = 'src/renamed # [한글].ts';
    await fixture.setLocalIdentity(fixture.globalIdentity);
    await fixture.writeText(originalPath, 'export const owned = true;\n');
    await fixture.commit('author writes file');
    await fixture.setLocalIdentity(alice);
    await fixture.run(['mv', '--', originalPath, renamedPath]);
    await fixture.commit('other author renames file');
    const repository = await GitRepository.discover(fixture.root, fixture.runner);

    const index = await repository.getUserIndex(fixture.globalIdentity);

    expect(index.commits.map(({ subject }) => subject)).toEqual(['author writes file']);
    expect(index.entries[0]?.changes).toEqual([{
      status: 'A', path: renamedPath, historicalPath: originalPath
    }]);

    const storagePath = await createTemporaryDirectory();
    const analyzer = new RepositoryAnalyzer(
      repository,
      new CacheStore(storagePath)
    );
    await analyzer.initialize();
    const current = await analyzer.ensureFile(renamedPath, 'active-editor');

    expect(analyzer.getFile(originalPath)).toBeUndefined();
    expect(current).toMatchObject({
      relativePath: renamedPath,
      kind: 'added',
      exists: true,
      aliases: [originalPath, renamedPath]
    });
    expect(current?.ranges).toEqual([
      expect.objectContaining({
        commit: expect.objectContaining({ authorEmail: fixture.globalIdentity.email }),
        uncommitted: false
      })
    ]);
    analyzer.dispose();

    const cachedAnalyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));
    await cachedAnalyzer.initialize();
    const cached = await cachedAnalyzer.ensureFile(renamedPath, 'active-editor');
    expect(cached).toMatchObject({ aliases: [originalPath, renamedPath] });
    cachedAnalyzer.dispose();
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

    await fixture.run(['config', '--global', 'user.name', 'Someone Else']);
    await fixture.run(['config', '--global', 'user.email', 'someone-else@example.com']);
    const differentIdentity = new RepositoryAnalyzer(repository, cacheStore);
    await differentIdentity.initialize();
    expect(calls.logScans).toBe(2);
    expect(differentIdentity.getSnapshot().files).toEqual([]);

    await fixture.run(['config', '--global', 'user.name', fixture.globalIdentity.name]);
    await fixture.run(['config', '--global', 'user.email', fixture.globalIdentity.email]);
    await second.refresh('identity');
    await second.ensureFile('cached.ts', 'active-editor');
    const cachedBlamesBeforeHeadChange = count(calls.blamedPaths, 'cached.ts');

    await fixture.writeText('head-change.ts', 'export const head = true;\n');
    await fixture.commit('advance head');
    await second.refresh('head');
    await second.ensureFile('cached.ts', 'active-editor');
    expect(calls.logScans).toBe(3);
    expect(count(calls.blamedPaths, 'cached.ts')).toBeGreaterThan(cachedBlamesBeforeHeadChange);

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
    expect(calls.logScans).toBe(3);
    expect(count(calls.blamedPaths, 'cached.ts')).toBeGreaterThan(cachedBlamesBefore);
    expect(count(calls.blamedPaths, 'unaffected.ts')).toBe(unaffectedBlamesBefore);

    await cacheStore.clearRepository(fixture.root);
    expect(await readdir(storagePath)).toEqual([]);
  });

  it('prioritizes active editors while limiting blame work to four jobs', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const paths = Array.from({ length: 7 }, (_, index) => `priority-${index + 1}.ts`);
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
    const explorer = analyzer.ensureFile('priority-6.ts', 'explorer');
    const urgent = analyzer.ensureFile('priority-7.ts', 'active-editor');
    await waitUntil(() => started.length >= 4);
    releases.get(started[0] as string)?.resolve();
    await waitUntil(() => started.length >= 5 && started.includes('priority-7.ts'));
    releases.get(started[1] as string)?.resolve();
    await waitUntil(() => started.length >= 6 && started.includes('priority-6.ts'));
    for (const release of releases.values()) release.resolve();
    await Promise.all([urgent, explorer]);
    await waitUntil(() => completed === paths.length);

    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(started[4]).toBe('priority-7.ts');
    expect(started[5]).toBe('priority-6.ts');
  });

  it('reports idle only after every background candidate has settled', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const path = 'startup-idle.ts';
    await writeFile(join(root, path), 'owned\n');
    const blame = deferred<BlameLine[]>();
    const repository = new ControlledRepository(root, [path], async () => blame.promise);
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    let idle = false;
    const waiting = analyzer.waitForIdle().then(() => {
      idle = true;
    });
    await nextTurn();

    expect(idle).toBe(false);

    blame.resolve([ownedLine(userCommit)]);
    await waiting;

    expect(analyzer.getSnapshot()).toMatchObject({
      scanning: false,
      files: [{ relativePath: path, kind: 'modified' }]
    });
    analyzer.dispose();
  });

  it('keeps the previous file list visible and settles a manual refresh only after one final publication', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const path = 'atomic.ts';
    await writeFile(join(root, path), 'owned\n');
    const replacement = deferred<BlameLine[]>();
    let blameCalls = 0;
    const repository = new ControlledRepository(root, [path], async () => {
      blameCalls += 1;
      return blameCalls === 1 ? [ownedLine(userCommit)] : replacement.promise;
    });
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    await analyzer.ensureFile(path, 'active-editor');
    await waitUntil(() => !analyzer.getSnapshot().scanning);
    const publications: RepositorySnapshot[] = [];
    analyzer.onDidChange((snapshot) => publications.push(snapshot));
    let settled = false;

    const refresh = analyzer.refresh('manual', [path]).then(() => {
      settled = true;
    });
    await waitUntil(() => blameCalls === 2);
    await nextTurn();

    expect(settled).toBe(false);
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({
      scanning: true,
      files: [{ relativePath: path, kind: 'modified' }]
    });

    replacement.resolve([ownedLine(aliceCommit)]);
    await refresh;

    expect(publications).toHaveLength(2);
    expect(publications[1]).toMatchObject({
      scanning: false,
      files: [{ relativePath: path, kind: 'past' }]
    });
    analyzer.dispose();
  });

  it('includes a deleted visible-file request in one atomic manual refresh publication', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const path = 'deleted-visible.ts';
    await writeFile(join(root, path), 'owned\n');
    const repository = new ControlledRepository(root, [path], async () => [ownedLine(userCommit)]);
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    await analyzer.ensureFile(path, 'active-editor');
    await waitUntil(() => !analyzer.getSnapshot().scanning);
    await unlink(join(root, path));
    const publications: RepositorySnapshot[] = [];
    let visibleRequest: Promise<FileRecord | undefined> | undefined;
    analyzer.onDidChange((snapshot) => {
      publications.push(snapshot);
      if (snapshot.scanning) visibleRequest = analyzer.ensureFile(path, 'active-editor');
    });

    await analyzer.refresh('manual', [path]);
    await visibleRequest;
    await nextTurn();

    expect(publications).toHaveLength(2);
    expect(publications[0]).toMatchObject({
      scanning: true,
      files: [{ relativePath: path, exists: true }]
    });
    expect(publications[1]).toMatchObject({
      scanning: false,
      files: [{ relativePath: path, kind: 'past', exists: false, ranges: [] }]
    });
    analyzer.dispose();
  });

  it('settles an explicit queued request retargeted to a deleted file before manual refresh returns', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const blockers = Array.from({ length: 4 }, (_, index) => 'blocker-' + (index + 1) + '.ts');
    const deletedPath = 'retargeted-deleted.ts';
    await Promise.all([...blockers, deletedPath].map(async (path) => writeFile(join(root, path), 'owned\n')));
    const releases = blockers.map(() => deferred<void>());
    let head = 'a'.repeat(40);
    let indexedPaths: readonly string[] = [...blockers, deletedPath];
    let blockerStarts = 0;
    const repository: RepositoryAccess = {
      root,
      getGlobalIdentity: async () => ({ name: userCommit.authorName, email: userCommit.authorEmail }),
      getHead: async () => head,
      getUserIndex: async () => indexForPaths(indexedPaths),
      getWorkingChanges: async () => [],
      blame: async (path) => {
        const index = blockers.indexOf(path);
        if (index >= 0) {
          blockerStarts += 1;
          await releases[index]?.promise;
        }
        return [ownedLine(userCommit)];
      }
    };
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    await waitUntil(() => blockerStarts === 4);
    const explicit = analyzer.ensureFile(deletedPath, 'active-editor');
    await unlink(join(root, deletedPath));
    head = 'b'.repeat(40);
    indexedPaths = [deletedPath];
    const publications: RepositorySnapshot[] = [];
    analyzer.onDidChange((snapshot) => publications.push(snapshot));

    await analyzer.refresh('manual', [deletedPath]);
    await expect(explicit).resolves.toMatchObject({
      relativePath: deletedPath,
      kind: 'past',
      exists: false,
      ranges: []
    });
    await nextTurn();

    expect(publications).toHaveLength(2);
    expect(publications.at(-1)).toMatchObject({ scanning: false });
    for (const release of releases) release.resolve();
    analyzer.dispose();
  });

  it('disposes queued work, settles explicit callers, and suppresses late publications', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const paths = Array.from({ length: 6 }, (_, index) => `dispose-${index + 1}.ts`);
    await Promise.all(paths.map(async (path) => writeFile(join(root, path), 'owned\n')));
    const starts: { path: string; release: Deferred<void> }[] = [];
    const repository = new ControlledRepository(root, paths, async (path) => {
      const release = deferred<void>();
      starts.push({ path, release });
      await release.promise;
      return [ownedLine(userCommit)];
    });
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));
    const publications: RepositorySnapshot[] = [];
    analyzer.onDidChange((snapshot) => publications.push(snapshot));

    await analyzer.initialize();
    await waitUntil(() => starts.length === 4);
    const explicit = analyzer.ensureFile('dispose-5.ts', 'active-editor');
    const publicationCount = publications.length;

    analyzer.dispose();

    await expect(explicit).resolves.toMatchObject({ relativePath: 'dispose-5.ts' });
    await expect(analyzer.ensureFile('dispose-6.ts', 'active-editor'))
      .resolves.toMatchObject({ relativePath: 'dispose-6.ts' });
    await analyzer.refresh('manual');
    for (const { release } of starts) release.resolve();
    await nextTurn();
    await nextTurn();

    expect(starts).toHaveLength(4);
    expect(publications).toHaveLength(publicationCount);
    expect(analyzer.getSnapshot().scanning).toBe(false);
    const afterDispose = vi.fn();
    analyzer.onDidChange(afterDispose);
    await analyzer.refresh('manual');
    expect(afterDispose).not.toHaveBeenCalled();
  });

  it('analyzes valid files whose names begin with two dots', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const path = '..generated.ts';
    await writeFile(join(root, path), 'owned\n');
    const repository = new ControlledRepository(root, [path], async () => [ownedLine(userCommit)]);
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    await analyzer.ensureFile(path, 'active-editor');

    expect(analyzer.getFile(path)).toMatchObject({
      relativePath: path,
      kind: 'modified',
      ranges: [expect.objectContaining({ commit: expect.objectContaining({ hash: userCommit.hash }) })]
    });
    analyzer.dispose();
  });

  it('drops superseded queued blame jobs before they start', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const paths = Array.from({ length: 6 }, (_, index) => `stale-queue-${index + 1}.ts`);
    await Promise.all(paths.map(async (path) => writeFile(join(root, path), 'owned\n')));
    const starts: { path: string; release: Deferred<void> }[] = [];
    const repository = new ControlledRepository(root, paths, async (path) => {
      const release = deferred<void>();
      starts.push({ path, release });
      await release.promise;
      return [ownedLine(userCommit)];
    });
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    await waitUntil(() => starts.length === 4);
    await analyzer.refresh('working-tree', paths);
    await drainBlameStarts(starts, analyzer);

    expect(starts).toHaveLength(10);
    expect(starts.filter(({ path }) => path === 'stale-queue-5.ts')).toHaveLength(1);
    expect(starts.filter(({ path }) => path === 'stale-queue-6.ts')).toHaveLength(1);
  });

  it('retargets an explicit queued file request to the current generation', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const paths = Array.from({ length: 5 }, (_, index) => `retarget-${index + 1}.ts`);
    await Promise.all(paths.map(async (path) => writeFile(join(root, path), 'owned\n')));
    const staleReleases: Deferred<void>[] = [];
    let blameStarts = 0;
    const repository = new ControlledRepository(root, paths, async () => {
      blameStarts += 1;
      if (blameStarts <= 4) {
        const release = deferred<void>();
        staleReleases.push(release);
        await release.promise;
        return [ownedLine(aliceCommit)];
      }
      return [ownedLine(userCommit)];
    });
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    await waitUntil(() => staleReleases.length === 4);
    const explicit = analyzer.ensureFile('retarget-5.ts', 'active-editor');
    await analyzer.refresh('working-tree', paths);
    for (const release of staleReleases) release.resolve();

    await expect(explicit).resolves.toMatchObject({
      relativePath: 'retarget-5.ts',
      ranges: [expect.objectContaining({
        commit: expect.objectContaining({ hash: userCommit.hash })
      })]
    });
    await waitUntil(() => !analyzer.getSnapshot().scanning);
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
    const onError = vi.fn();
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath), onError);

    await analyzer.initialize();
    await analyzer.ensureFile('reported-binary.dat', 'active-editor');

    expect(analyzer.getFile('reported-binary.dat')).toMatchObject({
      binary: true,
      ranges: []
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports unexpected blame failures and retains the last valid ownership until replacement succeeds', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    await writeFile(join(root, 'retained.ts'), 'owned\n');
    let blameCalls = 0;
    const error = new Error('unexpected blame parse failure');
    const repository = new ControlledRepository(root, ['retained.ts'], async () => {
      blameCalls += 1;
      if (blameCalls === 1) return [ownedLine(userCommit)];
      throw error;
    });
    const onError = vi.fn();
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath), onError);
    await analyzer.initialize();
    await analyzer.ensureFile('retained.ts', 'active-editor');
    const lastValid = analyzer.getFile('retained.ts')?.ranges;

    await analyzer.refresh('working-tree', ['retained.ts']);
    await expect(analyzer.ensureFile('retained.ts', 'active-editor')).rejects.toThrow(
      'unexpected blame parse failure'
    );

    expect(onError).toHaveBeenCalledWith(error, 'blame', 'retained.ts');
    expect(analyzer.getFile('retained.ts')?.ranges).toEqual(lastValid);
  });

  it('latches an unexpected blame failure across publication feedback until a new generation retries', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    await writeFile(join(root, 'latched.ts'), 'first\nsecond\n');
    const recoveredCommit: CommitSummary = {
      ...userCommit,
      hash: '4'.repeat(40),
      subject: 'recovered ownership'
    };
    let mode: 'initial' | 'failing' | 'recovered' = 'initial';
    let blameCalls = 0;
    const error = new Error('persistent blame parse failure');
    const repository = new ControlledRepository(root, ['latched.ts'], async () => {
      blameCalls += 1;
      if (mode === 'initial') return [ownedLine(userCommit)];
      if (mode === 'failing') throw error;
      return [{ line: 1, commit: recoveredCommit, uncommitted: false }];
    });
    const onError = vi.fn();
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath), onError);
    await analyzer.initialize();
    await analyzer.ensureFile('latched.ts', 'active-editor');
    await waitUntil(() => !analyzer.getSnapshot().scanning);
    const lastValid = analyzer.getFile('latched.ts')?.ranges;

    let feedbackRequests = 0;
    const feedback = analyzer.onDidChange(() => {
      if (feedbackRequests >= 4) return;
      feedbackRequests += 1;
      void analyzer.ensureFile('latched.ts', 'active-editor').catch(() => undefined);
    });
    mode = 'failing';
    await analyzer.refresh('working-tree', ['latched.ts']);
    await waitUntil(() => onError.mock.calls.length > 0);
    for (let turn = 0; turn < 8; turn += 1) await nextTurn();
    await waitUntil(() => !analyzer.getSnapshot().scanning);
    const sameGeneration = await Promise.allSettled([
      analyzer.ensureFile('latched.ts', 'active-editor'),
      analyzer.ensureFile('latched.ts', 'explorer'),
      analyzer.ensureFile('latched.ts', 'active-editor')
    ]);
    for (let turn = 0; turn < 4; turn += 1) await nextTurn();

    expect(sameGeneration.every(({ status }) => status === 'rejected')).toBe(true);
    expect(blameCalls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, 'blame', 'latched.ts');
    expect(analyzer.getFile('latched.ts')?.ranges).toEqual(lastValid);

    mode = 'recovered';
    await analyzer.refresh('manual', ['latched.ts']);
    await analyzer.ensureFile('latched.ts', 'active-editor');
    await waitUntil(() => !analyzer.getSnapshot().scanning);
    feedback.dispose();

    expect(blameCalls).toBe(3);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(analyzer.getFile('latched.ts')?.ranges).toEqual([{
      start: 1,
      endExclusive: 2,
      commit: recoveredCommit,
      uncommitted: false
    }]);
  });

  it('settles scanning immediately when the index has no candidate files', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const repository = new ControlledRepository(root, [], async () => []);
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();

    expect(analyzer.getSnapshot()).toMatchObject({ files: [], scanning: false });
  });

  it('shares one cold index scan across concurrent refresh generations', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    await writeFile(join(root, 'shared.ts'), 'shared\n');
    const repository = new DeferredIndexRepository(root, ['shared.ts']);
    const cacheStore = new AlwaysMissCacheStore(storagePath);
    const analyzer = new RepositoryAnalyzer(repository, cacheStore);

    const initialize = analyzer.initialize();
    await waitUntil(() => repository.logScans === 1);
    const overlappingRefresh = analyzer.refresh('manual');
    await waitUntil(() => repository.workingReads === 2);
    await nextTurn();
    repository.resolveIndex();
    await Promise.all([initialize, overlappingRefresh]);

    expect(repository.logScans).toBe(1);
  });

  it('serializes cold index scans when concurrent refreshes use different cache keys', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    await writeFile(join(root, 'shared.ts'), 'shared\n');
    const repository = new ChangingKeyIndexRepository(root, ['shared.ts']);
    const analyzer = new RepositoryAnalyzer(repository, new AlwaysMissCacheStore(storagePath));

    const initialize = analyzer.initialize();
    await waitUntil(() => repository.logScans === 1);
    repository.head = 'c'.repeat(40);
    const overlappingRefresh = analyzer.refresh('head');
    await nextTurn();
    await nextTurn();

    repository.resolveScan(0);
    await waitUntil(() => repository.logScans === 2);
    repository.resolveScan(1);
    await Promise.all([initialize, overlappingRefresh]);

    expect(repository.logScans).toBe(2);
    expect(repository.maxActiveScans).toBe(1);
  });

  it('bounds candidate stats, reads only file headers, and streams untracked line counts', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    const regularPaths = Array.from({ length: 64 }, (_, index) => `src/file-${index}.ts`);
    const trackedPath = 'large-tracked.ts';
    const binaryPath = 'large-binary.dat';
    const untrackedPath = 'large-untracked.ts';
    const largeSize = 5 * 1024 * 1024;
    const fileSystem = new InstrumentedAnalysisFileSystem(new Map([
      [trackedPath, { size: largeSize, binary: false }],
      [binaryPath, { size: largeSize, binary: true }],
      [untrackedPath, { size: largeSize, binary: false }]
    ]));
    const repository = new ControlledRepository(
      root,
      [...regularPaths, trackedPath, binaryPath],
      async () => [],
      async () => [{ status: '?', path: untrackedPath }]
    );
    const analyzer = new RepositoryAnalyzer(
      repository,
      new CacheStore(storagePath),
      undefined,
      fileSystem
    );

    await analyzer.initialize();
    await waitUntil(() => !analyzer.getSnapshot().scanning);

    expect(fileSystem.statCalls).toBe(regularPaths.length + 3);
    expect(fileSystem.maxActiveStats).toBeLessThanOrEqual(16);
    expect(fileSystem.maxReadRequest).toBeLessThanOrEqual(64 * 1024);
    expect(fileSystem.bytesReadFor(trackedPath)).toBeLessThanOrEqual(8192);
    expect(fileSystem.bytesReadFor(binaryPath)).toBeLessThanOrEqual(8192);
    expect(fileSystem.bytesReadFor(untrackedPath)).toBe(largeSize);
    expect(analyzer.getFile(binaryPath)).toMatchObject({ binary: true, ranges: [] });
    expect(analyzer.getFile(untrackedPath)?.ranges).toEqual([
      { start: 0, endExclusive: 1, uncommitted: true }
    ]);
  });

  it('rejects unsafe paths and missing commit references in the disk cache', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    await writeFile(join(root, 'safe.ts'), 'safe\n');
    const cacheStore = new CacheStore(storagePath);
    const key: CacheIndexKey = {
      rootHash: hashRepositoryRoot(root),
      head: 'a'.repeat(40),
      normalizedIdentity: '["history-aliases-v1","me","me@example.com"]'
    };
    const malformedHashCommits = [41, 63].map((length) => ({
      ...userCommit,
      hash: '3'.repeat(length)
    }));
    const corruptIndexes: CachedRepositoryIndex[] = [
      {
        commits: [userCommit],
        files: [{
          relativePath: '../outside.ts',
          introducedByUser: false,
          commitHashes: [userCommit.hash]
        }]
      },
      {
        commits: [userCommit],
        files: [{
          relativePath: 'nested/../safe.ts',
          introducedByUser: false,
          commitHashes: [userCommit.hash]
        }]
      },
      {
        commits: [userCommit],
        files: [{
          relativePath: 'C:/absolute.ts',
          introducedByUser: false,
          commitHashes: [userCommit.hash]
        }]
      },
      {
        commits: [userCommit],
        files: [{
          relativePath: 'safe.ts',
          introducedByUser: false,
          commitHashes: ['f'.repeat(40)]
        }]
      },
      ...malformedHashCommits.map((commit) => ({
        commits: [commit],
        files: [{
          relativePath: 'safe.ts',
          introducedByUser: false,
          commitHashes: [commit.hash]
        }]
      }))
    ];

    for (const corrupt of corruptIndexes) {
      await cacheStore.saveIndex(key, corrupt);
      const repository = new StaticRepository(root, ['safe.ts']);
      const analyzer = new RepositoryAnalyzer(repository, cacheStore);

      await analyzer.initialize();
      await analyzer.ensureFile('safe.ts', 'active-editor');

      expect(repository.logScans).toBe(1);
      expect(analyzer.getFile('safe.ts')?.exists).toBe(true);
    }
  });

  it('invalidates indexes created before history aliases were cached', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    await writeFile(join(root, 'safe.ts'), 'safe\n');
    const cacheStore = new CacheStore(storagePath);
    await cacheStore.saveIndex({
      rootHash: hashRepositoryRoot(root),
      head: 'a'.repeat(40),
      normalizedIdentity: '["me","me@example.com"]'
    }, {
      commits: [userCommit],
      files: [{
        relativePath: 'safe.ts', introducedByUser: false, commitHashes: [userCommit.hash]
      }]
    });
    const repository = new StaticRepository(root, ['safe.ts']);
    const analyzer = new RepositoryAnalyzer(repository, cacheStore);

    await analyzer.initialize();
    await analyzer.ensureFile('safe.ts', 'active-editor');

    expect(repository.logScans).toBe(1);
    analyzer.dispose();
  });

  it('accepts a literal backslash in a POSIX cache path without rewriting it', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const storagePath = await createTemporaryDirectory();
      const cacheStore = new CacheStore(storagePath);
      const key: CacheIndexKey = {
        rootHash: hashRepositoryRoot('/repo'),
        head: 'a'.repeat(40),
        normalizedIdentity: '["me","me@example.com"]'
      };
      const value: CachedRepositoryIndex = {
        commits: [userCommit],
        files: [{
          relativePath: 'src/literal\\backslash.ts',
          introducedByUser: false,
          commitHashes: [userCommit.hash]
        }]
      };

      await cacheStore.saveIndex(key, value);

      expect(await cacheStore.loadIndex(key)).toEqual(value);
    } finally {
      platform.mockRestore();
    }
  });

  it('preserves a literal backslash candidate through POSIX analyzer lookup and blame', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const root = await createTemporaryDirectory();
      const path = 'src/literal\\backslash.ts';
      const fileSystem = new InstrumentedAnalysisFileSystem(new Map([
        [path, { size: 6, binary: false }]
      ]));
      const repository = new ControlledRepository(
        root,
        [path],
        async () => [ownedLine(userCommit)]
      );
      const analyzer = new RepositoryAnalyzer(
        repository,
        new AlwaysMissCacheStore(await createTemporaryDirectory()),
        undefined,
        fileSystem
      );

      await analyzer.initialize();
      await waitUntil(() => !analyzer.getSnapshot().scanning);

      expect(analyzer.getSnapshot().files.map(({ relativePath }) => relativePath)).toEqual([path]);
      expect((await analyzer.ensureFile(path, 'active-editor'))?.ranges).toEqual([
        { start: 0, endExclusive: 1, commit: userCommit, uncommitted: false }
      ]);
    } finally {
      platform.mockRestore();
    }
  });

  it('settles the current snapshot when refresh fails', async () => {
    const root = await createTemporaryDirectory();
    const storagePath = await createTemporaryDirectory();
    await writeFile(join(root, 'retained.ts'), 'retained\n');
    const blameGate = deferred<void>();
    let blameStarted = false;
    let failWorkingRead = false;
    const repository = new ControlledRepository(
      root,
      ['retained.ts'],
      async () => {
        blameStarted = true;
        await blameGate.promise;
        return [ownedLine(userCommit)];
      },
      async () => {
        if (failWorkingRead) throw new Error('controlled refresh failure');
        return [];
      }
    );
    const analyzer = new RepositoryAnalyzer(repository, new CacheStore(storagePath));

    await analyzer.initialize();
    await waitUntil(() => blameStarted);
    expect(analyzer.getSnapshot().scanning).toBe(true);
    failWorkingRead = true;

    await expect(analyzer.refresh('manual')).rejects.toThrow('controlled refresh failure');

    expect(analyzer.getFile('retained.ts')).toBeDefined();
    expect(analyzer.getSnapshot().scanning).toBe(false);
    blameGate.resolve();
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
  await fixture.writeText('mine-deleted.ts', 'export const deleted = true;\n');
  await fixture.writeBytes('mine-binary.dat', Buffer.from([65, 0, 66]));
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
  await fixture.run(['rm', '--', 'mine-deleted.ts']);
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
    private readonly runBlame: (path: string) => Promise<BlameLine[]>,
    private readonly readWorkingChanges: () => Promise<WorkingChange[]> = async () => []
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
    return this.readWorkingChanges();
  }

  public blame(path: string): Promise<BlameLine[]> {
    return this.runBlame(path);
  }
}

class AlwaysMissCacheStore extends CacheStore {
  public override async loadIndex(_key: CacheIndexKey): Promise<CachedRepositoryIndex | undefined> {
    return undefined;
  }

  public override async saveIndex(
    _key: CacheIndexKey,
    _value: CachedRepositoryIndex
  ): Promise<void> {}
}

class DeferredIndexRepository implements RepositoryAccess {
  private readonly index = deferred<UserIndex>();
  public logScans = 0;
  public workingReads = 0;

  public constructor(
    public readonly root: string,
    private readonly paths: readonly string[]
  ) {}

  public async getGlobalIdentity(): Promise<GitIdentity> {
    return { name: 'Me', email: 'me@example.com' };
  }

  public async getHead(): Promise<string> {
    return 'b'.repeat(40);
  }

  public async getUserIndex(_identity: GitIdentity): Promise<UserIndex> {
    this.logScans += 1;
    return this.index.promise;
  }

  public async getWorkingChanges(): Promise<WorkingChange[]> {
    this.workingReads += 1;
    return [];
  }

  public async blame(_path: string): Promise<BlameLine[]> {
    return [];
  }

  public resolveIndex(): void {
    this.index.resolve(indexForPaths(this.paths));
  }
}

class ChangingKeyIndexRepository implements RepositoryAccess {
  private readonly scans: Array<Deferred<UserIndex>> = [];
  public head = 'b'.repeat(40);
  public logScans = 0;
  public maxActiveScans = 0;
  private activeScans = 0;

  public constructor(
    public readonly root: string,
    private readonly paths: readonly string[]
  ) {}

  public async getGlobalIdentity(): Promise<GitIdentity> {
    return { name: 'Me', email: 'me@example.com' };
  }

  public async getHead(): Promise<string> {
    return this.head;
  }

  public async getUserIndex(_identity: GitIdentity): Promise<UserIndex> {
    const scan = deferred<UserIndex>();
    this.scans.push(scan);
    this.logScans += 1;
    this.activeScans += 1;
    this.maxActiveScans = Math.max(this.maxActiveScans, this.activeScans);
    try {
      return await scan.promise;
    } finally {
      this.activeScans -= 1;
    }
  }

  public async getWorkingChanges(): Promise<WorkingChange[]> {
    return [];
  }

  public async blame(_path: string): Promise<BlameLine[]> {
    return [];
  }

  public resolveScan(index: number): void {
    this.scans[index]?.resolve(indexForPaths(this.paths));
  }
}

class StaticRepository implements RepositoryAccess {
  public logScans = 0;

  public constructor(
    public readonly root: string,
    private readonly paths: readonly string[]
  ) {}

  public async getGlobalIdentity(): Promise<GitIdentity> {
    return { name: 'Me', email: 'me@example.com' };
  }

  public async getHead(): Promise<string> {
    return 'a'.repeat(40);
  }

  public async getUserIndex(_identity: GitIdentity): Promise<UserIndex> {
    this.logScans += 1;
    return indexForPaths(this.paths);
  }

  public async getWorkingChanges(): Promise<WorkingChange[]> {
    return [];
  }

  public async blame(_path: string): Promise<BlameLine[]> {
    return [];
  }
}

class InstrumentedAnalysisFileSystem {
  public statCalls = 0;
  public maxActiveStats = 0;
  public maxReadRequest = 0;
  private activeStats = 0;
  private readonly bytesRead = new Map<string, number>();

  public constructor(
    private readonly largeFiles: ReadonlyMap<string, { readonly size: number; readonly binary: boolean }>
  ) {}

  public async stat(_path: string): Promise<{ isFile(): boolean }> {
    this.statCalls += 1;
    this.activeStats += 1;
    this.maxActiveStats = Math.max(this.maxActiveStats, this.activeStats);
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.activeStats -= 1;
    return { isFile: () => true };
  }

  public async open(path: string): Promise<{
    read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
  }> {
    const entry = [...this.largeFiles].find(([relativePath]) => path.endsWith(relativePath));
    const relativePath = entry?.[0] ?? path;
    const size = entry?.[1].size ?? 1;
    const binary = entry?.[1].binary ?? false;
    let cursor = 0;
    return {
      read: async (buffer, offset, length, position) => {
        this.maxReadRequest = Math.max(this.maxReadRequest, length);
        const start = position ?? cursor;
        const bytesRead = Math.max(0, Math.min(length, size - start));
        buffer.fill(0x61, offset, offset + bytesRead);
        if (binary && start === 0 && bytesRead > 0) buffer[offset] = 0;
        cursor = start + bytesRead;
        this.bytesRead.set(relativePath, (this.bytesRead.get(relativePath) ?? 0) + bytesRead);
        return { bytesRead };
      },
      close: async () => undefined
    };
  }

  public bytesReadFor(relativePath: string): number {
    return this.bytesRead.get(relativePath) ?? 0;
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

function indexForPaths(paths: readonly string[]): UserIndex {
  return {
    commits: [userCommit],
    entries: [{
      commit: userCommit,
      changes: paths.map((path) => ({ status: 'M', path }))
    }]
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function drainBlameStarts(
  starts: readonly { readonly release: Deferred<void> }[],
  analyzer: RepositoryAnalyzer
): Promise<void> {
  const released = new Set<Deferred<void>>();
  const deadline = Date.now() + 5_000;
  while (true) {
    for (const { release } of starts) {
      if (!released.has(release)) {
        released.add(release);
        release.resolve();
      }
    }
    await nextTurn();
    if (!analyzer.getSnapshot().scanning && starts.every(({ release }) => released.has(release))) {
      await nextTurn();
      if (starts.every(({ release }) => released.has(release))) return;
    }
    if (Date.now() > deadline) throw new Error('timed out draining blame jobs');
  }
}
