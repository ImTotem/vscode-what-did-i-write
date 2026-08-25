import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkingChange } from '../../src/git/parsers.js';
import type { RepositorySnapshot } from '../../src/core/model.js';
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
    expect(registry.repositories).toHaveLength(1);
    expect(analyzer.dispose).not.toHaveBeenCalled();
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
    expect(repository.getFingerprint).toHaveBeenCalledOnce();
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
      .mockResolvedValueOnce({ head: 'b', status: 'clean' })
      .mockResolvedValueOnce({ head: 'b', status: 'dirty' });
    repository.getWorkingChanges.mockResolvedValue([{ status: 'M', path: 'src/changed.ts' }]);

    await controller.tick();
    await controller.tick();
    await controller.tick();
    await controller.refreshAll();

    expect(analyzer.refresh).toHaveBeenNthCalledWith(1, 'head');
    expect(analyzer.refresh).toHaveBeenNthCalledWith(2, 'working-tree', ['src/changed.ts']);
    expect(analyzer.refresh).toHaveBeenNthCalledWith(3, 'manual');
    controller.dispose();
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
