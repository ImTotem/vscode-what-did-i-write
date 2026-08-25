import { isAbsolute, relative, resolve } from 'node:path';

import type { CacheStore } from '../analysis/cacheStore.js';
import {
  RepositoryAnalyzer,
  type AnalyzerDisposable,
  type RepositoryAccess as AnalyzerRepositoryAccess
} from '../analysis/repositoryAnalyzer.js';
import type { RepositorySnapshot } from '../core/model.js';
import { GitRunner } from '../git/gitRunner.js';
import type { WorkingChange } from '../git/parsers.js';
import { GitRepository, type RepositoryFingerprint } from '../git/repository.js';

export interface UriAccess {
  readonly fsPath: string;
}

export interface RepositoryAccess extends AnalyzerRepositoryAccess {
  getFingerprint(): Promise<RepositoryFingerprint>;
  getWorkingChanges(): Promise<WorkingChange[]>;
}

export interface AnalyzerAccess {
  initialize(): Promise<void>;
  refresh(reason: string, paths?: readonly string[]): Promise<void>;
  getSnapshot(): RepositorySnapshot;
  onDidChange(listener: (snapshot: RepositorySnapshot) => void): AnalyzerDisposable;
  dispose?(): void;
}

export interface RegisteredRepository {
  readonly root: string;
  readonly repository: RepositoryAccess;
  readonly analyzer: AnalyzerAccess;
  readonly workspaceFolders: readonly UriAccess[];
  readonly ready: boolean;
}

export type RegistryOperation = 'discover' | 'initialize';

export interface RepositoryRegistryOptions {
  readonly getWorkspaceFolders: () => readonly UriAccess[];
  readonly discover: (startPath: string) => Promise<RepositoryAccess>;
  readonly createAnalyzer: (repository: RepositoryAccess) => AnalyzerAccess;
  readonly onError?: (error: unknown, operation: RegistryOperation, path: string) => void;
}

class RepositoryLifetime implements RegisteredRepository {
  public workspaceFolders: readonly UriAccess[];
  public ready = false;
  private analyzerSubscription: AnalyzerDisposable | undefined;

  public constructor(
    public readonly root: string,
    public readonly repository: RepositoryAccess,
    public readonly analyzer: AnalyzerAccess,
    workspaceFolders: readonly UriAccess[],
    onAnalyzerChange: () => void
  ) {
    this.workspaceFolders = workspaceFolders;
    this.analyzerSubscription = analyzer.onDidChange(() => {
      this.ready = true;
      onAnalyzerChange();
    });
  }

  public setWorkspaceFolders(workspaceFolders: readonly UriAccess[]): void {
    this.workspaceFolders = workspaceFolders;
  }

  public markReady(): void {
    this.ready = true;
  }

  public dispose(): void {
    this.analyzerSubscription?.dispose();
    this.analyzerSubscription = undefined;
    this.analyzer.dispose?.();
  }
}

export class RepositoryRegistry {
  private readonly listeners = new Set<() => void>();
  private readonly lifetimes = new Map<string, RepositoryLifetime>();
  private generation = 0;
  private disposed = false;

  public constructor(private readonly options: RepositoryRegistryOptions) {}

  public static create(
    getWorkspaceFolders: () => readonly UriAccess[],
    cacheStore: CacheStore,
    onError?: RepositoryRegistryOptions['onError'],
    runner = new GitRunner()
  ): RepositoryRegistry {
    return new RepositoryRegistry({
      getWorkspaceFolders,
      discover: (startPath) => GitRepository.discover(startPath, runner),
      createAnalyzer: (repository) => new RepositoryAnalyzer(repository, cacheStore),
      onError
    });
  }

  public get repositories(): readonly RegisteredRepository[] {
    return [...this.lifetimes.values()].sort((left, right) => left.root.localeCompare(right.root));
  }

  public readonly onDidChange = (listener: () => void): AnalyzerDisposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  public start(): Promise<void> {
    return this.updateWorkspaceFolders(this.options.getWorkspaceFolders());
  }

  public async updateWorkspaceFolders(workspaceFolders: readonly UriAccess[]): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    const discoveries = await Promise.all(workspaceFolders.map(async (folder) => {
      try {
        return { folder, repository: await this.options.discover(folder.fsPath) };
      } catch (error) {
        this.options.onError?.(error, 'discover', folder.fsPath);
        return undefined;
      }
    }));
    if (this.disposed || generation !== this.generation) return;

    const grouped = new Map<string, {
      readonly repository: RepositoryAccess;
      readonly folders: UriAccess[];
    }>();
    for (const discovery of discoveries) {
      if (discovery === undefined) continue;
      const key = normalizeFsPath(discovery.repository.root);
      const group = grouped.get(key);
      if (group === undefined) {
        grouped.set(key, { repository: discovery.repository, folders: [discovery.folder] });
      } else {
        group.folders.push(discovery.folder);
      }
    }
    const activeFolderKeys = new Set(workspaceFolders.map(({ fsPath }) => normalizeFsPath(fsPath)));
    const discoveredFolderKeys = new Set(discoveries.flatMap((discovery) =>
      discovery === undefined ? [] : [normalizeFsPath(discovery.folder.fsPath)]
    ));
    for (const [key, lifetime] of this.lifetimes) {
      const retainedFolders = lifetime.workspaceFolders.filter(({ fsPath }) => {
        const folderKey = normalizeFsPath(fsPath);
        return activeFolderKeys.has(folderKey) && !discoveredFolderKeys.has(folderKey);
      });
      if (retainedFolders.length === 0) continue;
      const group = grouped.get(key);
      if (group === undefined) {
        grouped.set(key, { repository: lifetime.repository, folders: [...retainedFolders] });
      } else {
        group.folders.push(...retainedFolders);
      }
    }

    let changed = false;
    for (const [key, lifetime] of this.lifetimes) {
      if (!grouped.has(key)) {
        lifetime.dispose();
        this.lifetimes.delete(key);
        changed = true;
      }
    }
    for (const [key, group] of grouped) {
      const existing = this.lifetimes.get(key);
      if (existing !== undefined) {
        if (!sameFolders(existing.workspaceFolders, group.folders)) changed = true;
        existing.setWorkspaceFolders(group.folders);
        continue;
      }

      const analyzer = this.options.createAnalyzer(group.repository);
      const lifetime = new RepositoryLifetime(
        group.repository.root,
        group.repository,
        analyzer,
        group.folders,
        () => this.emitChange()
      );
      this.lifetimes.set(key, lifetime);
      changed = true;
      void analyzer.initialize().then(
        () => {
          if (this.lifetimes.get(key) !== lifetime) return;
          lifetime.markReady();
          this.emitChange();
        },
        (error: unknown) => {
          if (this.lifetimes.get(key) !== lifetime) return;
          lifetime.markReady();
          this.options.onError?.(error, 'initialize', lifetime.root);
          this.emitChange();
        }
      );
    }
    if (changed) this.emitChange();
  }

  public findByUri(uri: UriAccess): RegisteredRepository | undefined {
    let match: RepositoryLifetime | undefined;
    for (const lifetime of this.lifetimes.values()) {
      if (!containsPath(lifetime.root, uri.fsPath)) continue;
      if (match === undefined || normalizeFsPath(lifetime.root).length > normalizeFsPath(match.root).length) {
        match = lifetime;
      }
    }
    return match;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const lifetime of this.lifetimes.values()) lifetime.dispose();
    this.lifetimes.clear();
    this.listeners.clear();
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

function containsPath(root: string, candidate: string): boolean {
  const path = relative(normalizeFsPath(root), normalizeFsPath(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function normalizeFsPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function sameFolders(left: readonly UriAccess[], right: readonly UriAccess[]): boolean {
  if (left.length !== right.length) return false;
  const leftPaths = left.map(({ fsPath }) => normalizeFsPath(fsPath)).sort();
  const rightPaths = right.map(({ fsPath }) => normalizeFsPath(fsPath)).sort();
  return leftPaths.every((path, index) => path === rightPaths[index]);
}
