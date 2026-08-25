import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CacheStore } from '../../src/analysis/cacheStore.js';
import { RepositoryAnalyzer } from '../../src/analysis/repositoryAnalyzer.js';
import type { RepositorySnapshot } from '../../src/core/model.js';
import type { WorkingChange } from '../../src/git/parsers.js';
import {
  RepositoryRegistry,
  type AnalyzerAccess,
  type RepositoryAccess
} from '../../src/extension/repositoryRegistry.js';
import { RefreshController, type TimerScheduler } from '../../src/ui/refreshController.js';
import { StatusController } from '../../src/ui/statusController.js';

describe('RepositoryRegistry', () => {
  it('de-duplicates repository roots and disposes the final folder lifetime', async () => {
    const workspaceRoot = join(process.cwd(), 'workspace');
    const repositoryRoot = join(workspaceRoot, 'repository');
    const firstFolder = { fsPath: repositoryRoot };
    const nestedFolder = { fsPath: join(repositoryRoot, 'packages', 'nested') };
    const initialize = vi.fn(() => new Promise<void>(() => undefined));
    const analyzer = fakeAnalyzer(repositoryRoot, initialize);
    const repository = fakeRepository(repositoryRoot);
    const registry = new RepositoryRegistry({
      getWorkspaceFolders: () => [firstFolder, nestedFolder],
      discover: vi.fn(async () => repository),
      createAnalyzer: vi.fn(() => analyzer)
    });

    await registry.start();

    expect(registry.repositories).toHaveLength(1);
    expect(registry.repositories[0]?.workspaceFolders).toHaveLength(2);
    expect(initialize).toHaveBeenCalledOnce();
    expect(registry.findByUri({ fsPath: join(repositoryRoot, 'src', 'index.ts') }))
      .toBe(registry.repositories[0]);

    await registry.updateWorkspaceFolders([nestedFolder]);
    expect(analyzer.dispose).not.toHaveBeenCalled();

    await registry.updateWorkspaceFolders([]);
    expect(analyzer.dispose).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it('retains a repository when discovery transiently fails for a folder that still exists', async () => {
    const root = join(process.cwd(), 'repository');
    const folder = { fsPath: root };
    const analyzer = fakeAnalyzer(root);
    const repository = fakeRepository(root);
    const discover = vi.fn()
      .mockResolvedValueOnce(repository)
      .mockRejectedValueOnce(new Error('transient discovery failure'));
    const onError = vi.fn();
    const registry = new RepositoryRegistry({
      getWorkspaceFolders: () => [folder],
      discover,
      createAnalyzer: () => analyzer,
      onError
    });

    await registry.start();
    await registry.updateWorkspaceFolders([folder]);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'transient discovery failure' }),
      'discover',
      root
    );
    expect(registry.state).toBe('error');
    expect(registry.repositories).toHaveLength(1);
    expect(analyzer.dispose).not.toHaveBeenCalled();
    registry.dispose();
  });

  it('selects the deepest repository and accepts dot-dot-prefixed child names', async () => {
    const outerRoot = join(process.cwd(), 'outer');
    const innerRoot = join(outerRoot, 'packages', 'inner');
    const outer = fakeRepository(outerRoot);
    const inner = fakeRepository(innerRoot);
    const registry = new RepositoryRegistry({
      getWorkspaceFolders: () => [{ fsPath: outerRoot }, { fsPath: innerRoot }],
      discover: async (path) => path === innerRoot ? inner : outer,
      createAnalyzer: (repository) => fakeAnalyzer(repository.root)
    });

    await registry.start();

    expect(registry.findByUri({ fsPath: join(innerRoot, 'src', 'file.ts') })?.root).toBe(innerRoot);
    expect(registry.findByUri({ fsPath: join(outerRoot, '..generated', 'file.ts') })?.root)
      .toBe(outerRoot);
    expect(registry.findByUri({ fsPath: join(outerRoot, '..', 'outside.ts') })).toBeUndefined();
    registry.dispose();
  });

  it('disposes a real analyzer when its final workspace folder disappears', async () => {
    const root = join(process.cwd(), 'actual-analyzer');
    const repository = {
      ...fakeRepository(root),
      getGlobalIdentity: vi.fn(async () => ({ name: 'Me', email: 'me@example.com' })),
      getHead: vi.fn(async () => undefined),
      getUserIndex: vi.fn(async () => ({ commits: [], entries: [] })),
      blame: vi.fn(async () => [])
    } satisfies RepositoryAccess;
    let actualAnalyzer: RepositoryAnalyzer | undefined;
    const registry = new RepositoryRegistry({
      getWorkspaceFolders: () => [{ fsPath: root }],
      discover: async () => repository,
      createAnalyzer: (access) => {
        actualAnalyzer = new RepositoryAnalyzer(access, new CacheStore(undefined));
        return actualAnalyzer;
      }
    });

    await registry.start();
    await waitUntil(() => registry.state === 'ready');
    const headReads = repository.getHead.mock.calls.length;

    await registry.updateWorkspaceFolders([]);
    await (actualAnalyzer as RepositoryAnalyzer).refresh('manual');

    expect(repository.getHead).toHaveBeenCalledTimes(headReads);
    expect(registry.repositories).toEqual([]);
    registry.dispose();
  });
});

describe('RefreshController', () => {
  it('coalesces path events per repository and keeps polling focus-scoped', async () => {
    const root = join(process.cwd(), 'repository');
    const analyzer = fakeAnalyzer(root);
    const repository = fakeRepository(root);
    const registry = await registryWith(root, repository, analyzer);
    const scheduler = new FakeScheduler();
    const controller = new RefreshController(registry, { scheduler });

    controller.acceptSave({ fsPath: join(root, 'src', 'same.ts') });
    controller.acceptCreate([
      { fsPath: join(root, 'src', 'same.ts') },
      { fsPath: join(root, 'src', 'new.ts') }
    ]);
    expect(scheduler.timeoutDelay).toBe(250);

    await scheduler.runTimeout();
    expect(analyzer.refresh).toHaveBeenCalledWith('working-tree', ['src/new.ts', 'src/same.ts']);

    controller.setFocused(true);
    expect(scheduler.intervalDelay).toBe(10_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(repository.getFingerprint).toHaveBeenCalledTimes(2);
    expect(analyzer.refresh).toHaveBeenLastCalledWith('head');
    controller.setFocused(false);
    expect(scheduler.intervalCleared).toBe(true);
    controller.dispose();
  });

  it('uses fingerprints for head and working-path refreshes and manual refresh is full', async () => {
    const root = join(process.cwd(), 'repository');
    const analyzer = fakeAnalyzer(root);
    const repository = fakeRepository(root);
    const registry = await registryWith(root, repository, analyzer);
    const controller = new RefreshController(registry, { scheduler: new FakeScheduler() });

    repository.getFingerprint
      .mockResolvedValueOnce({ head: 'a', status: 'clean' })
      .mockResolvedValueOnce({ head: 'a', status: 'clean' })
      .mockResolvedValueOnce({ head: 'b', status: 'clean' })
      .mockResolvedValueOnce({ head: 'b', status: 'dirty' });
    repository.getWorkingChanges.mockResolvedValue([{ status: 'M', path: 'src/changed.ts' }]);

    await controller.tick();
    await controller.tick();
    await controller.tick();
    await controller.refreshAll();

    expect(analyzer.refresh).toHaveBeenNthCalledWith(1, 'head');
    expect(analyzer.refresh).toHaveBeenNthCalledWith(2, 'head');
    expect(analyzer.refresh).toHaveBeenNthCalledWith(3, 'working-tree', ['src/changed.ts']);
    expect(analyzer.refresh).toHaveBeenNthCalledWith(4, 'manual');
    controller.dispose();
  });

  it('refreshes before acknowledging an initial fingerprint and retries changes during refresh', async () => {
    const root = join(process.cwd(), 'repository');
    const analyzer = fakeAnalyzer(root);
    const repository = fakeRepository(root);
    const registry = await registryWith(root, repository, analyzer);
    const controller = new RefreshController(registry, { scheduler: new FakeScheduler() });
    repository.getFingerprint
      .mockResolvedValueOnce({ head: 'h1', status: 's1' })
      .mockResolvedValueOnce({ head: 'h2', status: 's2' })
      .mockResolvedValueOnce({ head: 'h2', status: 's2' })
      .mockResolvedValueOnce({ head: 'h2', status: 's2' })
      .mockResolvedValueOnce({ head: 'h2', status: 's2' });

    await controller.tick();
    await controller.tick();
    await controller.tick();

    expect(analyzer.refresh).toHaveBeenCalledTimes(2);
    expect(analyzer.refresh).toHaveBeenNthCalledWith(1, 'head');
    expect(analyzer.refresh).toHaveBeenNthCalledWith(2, 'head');
    controller.dispose();
  });

  it('routes delete and cross-repository rename paths including dot-dot-prefixed children', async () => {
    const outerRoot = join(process.cwd(), 'outer');
    const innerRoot = join(process.cwd(), 'inner');
    const outerAnalyzer = fakeAnalyzer(outerRoot);
    const innerAnalyzer = fakeAnalyzer(innerRoot);
    const outer = fakeRepository(outerRoot);
    const inner = fakeRepository(innerRoot);
    const registry = new RepositoryRegistry({
      getWorkspaceFolders: () => [{ fsPath: outerRoot }, { fsPath: innerRoot }],
      discover: async (path) => path === innerRoot ? inner : outer,
      createAnalyzer: (repository) => repository.root === innerRoot ? innerAnalyzer : outerAnalyzer
    });
    await registry.start();
    const scheduler = new FakeScheduler();
    const controller = new RefreshController(registry, { scheduler });

    controller.acceptDelete([{ fsPath: join(outerRoot, '..generated', 'deleted.ts') }]);
    controller.acceptRename([{
      oldUri: { fsPath: join(outerRoot, 'old.ts') },
      newUri: { fsPath: join(innerRoot, 'new.ts') }
    }]);
    controller.acceptDelete([{ fsPath: join(outerRoot, '..', 'outside.ts') }]);
    await scheduler.runTimeout();

    expect(outerAnalyzer.refresh).toHaveBeenCalledWith(
      'working-tree',
      ['..generated/deleted.ts', 'old.ts']
    );
    expect(innerAnalyzer.refresh).toHaveBeenCalledWith('working-tree', ['new.ts']);
    controller.dispose();
    registry.dispose();
  });

  it('retries a changed fingerprint when its refresh fails', async () => {
    const root = join(process.cwd(), 'repository');
    const analyzer = fakeAnalyzer(root);
    const repository = fakeRepository(root);
    const registry = await registryWith(root, repository, analyzer);
    const onError = vi.fn();
    const controller = new RefreshController(registry, {
      scheduler: new FakeScheduler(),
      onError
    });
    repository.getFingerprint
      .mockResolvedValueOnce({ head: 'a', status: 'clean' })
      .mockResolvedValueOnce({ head: 'b', status: 'clean' })
      .mockResolvedValueOnce({ head: 'b', status: 'clean' })
      .mockResolvedValueOnce({ head: 'b', status: 'clean' });
    analyzer.refresh
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(undefined);

    await controller.tick();
    await controller.tick();
    await controller.tick();

    expect(analyzer.refresh).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    controller.dispose();
  });
});

describe('StatusController', () => {
  it('distinguishes discovery, initialization, and initialization errors from identity', async () => {
    const root = join(process.cwd(), 'repository');
    const discovery = deferred<RepositoryAccess>();
    const initialization = deferred<void>();
    const analyzer = fakeAnalyzer(root, vi.fn(() => initialization.promise));
    const onError = vi.fn();
    const registry = new RepositoryRegistry({
      getWorkspaceFolders: () => [{ fsPath: root }],
      discover: async () => discovery.promise,
      createAnalyzer: () => analyzer,
      onError
    });
    const status = { text: '', show: vi.fn() };
    const showWarning = vi.fn(async () => undefined);
    const controller = new StatusController(registry, status, {
      showWarning,
      showOutput: vi.fn(),
      retryIdentity: vi.fn()
    });

    const start = registry.start();
    expect(registry.state).toBe('discovering');
    expect(status.text).toBe('$(sync~spin) My Code: Scanning');
    discovery.resolve(fakeRepository(root));
    await start;
    expect(registry.state).toBe('initializing');
    expect(status.text).toBe('$(sync~spin) My Code: Scanning');

    analyzer.publish(snapshot(root, { missingIdentity: true }));
    expect(status.text).toBe('$(sync~spin) My Code: Scanning');
    expect(showWarning).not.toHaveBeenCalled();

    initialization.reject(new Error('cache permission denied'));
    await waitUntil(() => registry.state === 'error');

    expect(status.text).toBe('$(warning) My Code: Error');
    expect(showWarning).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'cache permission denied' }),
      'initialize',
      root
    );
    controller.dispose();
    registry.dispose();
  });

  it('publishes aggregate states and warns once with actionable choices', async () => {
    const root = join(process.cwd(), 'repository');
    const analyzer = fakeAnalyzer(root);
    const repository = fakeRepository(root);
    const registry = await registryWith(root, repository, analyzer);
    const status = { text: '', show: vi.fn() };
    const showWarning = vi.fn(async () => undefined);
    const controller = new StatusController(registry, status, {
      showWarning,
      showOutput: vi.fn(),
      retryIdentity: vi.fn()
    });

    analyzer.publish(snapshot(root, { scanning: true }));
    expect(status.text).toBe('$(sync~spin) My Code: Scanning');
    analyzer.publish(snapshot(root, { fileCount: 2 }));
    expect(status.text).toBe('$(account) My Code: 2 files');
    analyzer.publish(snapshot(root, { missingIdentity: true }));
    analyzer.publish(snapshot(root, { missingIdentity: true }));
    await Promise.resolve();
    expect(status.text).toBe('$(warning) My Code: Git identity');
    expect(showWarning).toHaveBeenCalledTimes(1);
    expect(showWarning).toHaveBeenCalledWith(
      expect.stringContaining('identity'),
      'My Code: Retry'
    );

    controller.reportMissingGit(new Error('git unavailable'));
    controller.reportMissingGit(new Error('git unavailable'));
    await Promise.resolve();
    expect(showWarning).toHaveBeenCalledTimes(2);
    expect(showWarning).toHaveBeenLastCalledWith(
      expect.stringContaining('Git'),
      'My Code: Show Output'
    );
    controller.dispose();
  });
});

function fakeRepository(root: string) {
  return {
    root,
    getGlobalIdentity: vi.fn(),
    getHead: vi.fn(),
    getUserIndex: vi.fn(),
    getWorkingChanges: vi.fn(async (): Promise<WorkingChange[]> => []),
    blame: vi.fn(),
    getFingerprint: vi.fn(async () => ({ head: 'a', status: 'clean' }))
  } satisfies RepositoryAccess;
}

function fakeAnalyzer(root: string, initialize = vi.fn(async () => undefined)) {
  let current = snapshot(root);
  const listeners = new Set<(value: RepositorySnapshot) => void>();
  return {
    initialize,
    refresh: vi.fn(async () => undefined),
    getSnapshot: () => current,
    onDidChange: (listener: (value: RepositorySnapshot) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: vi.fn(),
    publish: (value: RepositorySnapshot) => {
      current = value;
      for (const listener of listeners) listener(value);
    }
  } satisfies AnalyzerAccess & { publish(value: RepositorySnapshot): void };
}

async function registryWith(
  root: string,
  repository: ReturnType<typeof fakeRepository>,
  analyzer: ReturnType<typeof fakeAnalyzer>
): Promise<RepositoryRegistry> {
  const registry = new RepositoryRegistry({
    getWorkspaceFolders: () => [{ fsPath: root }],
    discover: async () => repository,
    createAnalyzer: () => analyzer
  });
  await registry.start();
  return registry;
}

function snapshot(
  root: string,
  options: { readonly scanning?: boolean; readonly fileCount?: number; readonly missingIdentity?: boolean } = {}
): RepositorySnapshot {
  return {
    root,
    head: 'a',
    identity: options.missingIdentity ? { name: '', email: '' } : { name: 'Me', email: 'me@example.com' },
    files: Array.from({ length: options.fileCount ?? 0 }, (_, index) => ({
      relativePath: `file-${index}.ts`,
      kind: 'modified' as const,
      exists: true,
      working: false,
      binary: false,
      ranges: [],
      history: []
    })),
    scanning: options.scanning ?? false,
    generatedAt: 1
  };
}

class FakeScheduler implements TimerScheduler {
  public timeoutDelay: number | undefined;
  public intervalDelay: number | undefined;
  public intervalCleared = false;
  private timeout: (() => void) | undefined;

  public setTimeout(callback: () => void, delay: number): object {
    this.timeout = callback;
    this.timeoutDelay = delay;
    return {};
  }

  public clearTimeout(_handle: unknown): void {
    this.timeout = undefined;
  }

  public setInterval(_callback: () => void, delay: number): object {
    this.intervalDelay = delay;
    return {};
  }

  public clearInterval(_handle: unknown): void {
    this.intervalCleared = true;
  }

  public async runTimeout(): Promise<void> {
    const callback = this.timeout;
    this.timeout = undefined;
    callback?.();
    await Promise.resolve();
    await Promise.resolve();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (reason) => rejectPromise?.(reason)
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for lifecycle state');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
