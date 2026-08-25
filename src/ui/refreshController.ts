import { isAbsolute, relative, sep } from 'node:path';

import type {
  RegisteredRepository,
  RepositoryRegistry,
  UriAccess
} from '../extension/repositoryRegistry.js';

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

export interface TimerScheduler {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RenameAccess {
  readonly oldUri: UriAccess;
  readonly newUri: UriAccess;
}

export interface RefreshControllerOptions {
  readonly scheduler?: TimerScheduler;
  readonly debounceMs?: number;
  readonly pollIntervalMs?: number;
  readonly onError?: (error: unknown, operation: string, root: string) => void;
}

const defaultScheduler: TimerScheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

export class RefreshController {
  private readonly scheduler: TimerScheduler;
  private readonly pendingPaths = new Map<RegisteredRepository, Set<string>>();
  private readonly fingerprints = new Map<string, { readonly head: string | undefined; readonly status: string }>();
  private timeout: unknown;
  private interval: unknown;
  private pollRunning = false;
  private disposed = false;

  public constructor(
    private readonly registry: RepositoryRegistry,
    private readonly options: RefreshControllerOptions = {}
  ) {
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  public acceptSave(uri: UriAccess): void {
    this.acceptPath(uri);
  }

  public acceptCreate(uris: readonly UriAccess[]): void {
    for (const uri of uris) this.acceptPath(uri);
  }

  public acceptDelete(uris: readonly UriAccess[]): void {
    for (const uri of uris) this.acceptPath(uri);
  }

  public acceptRename(events: readonly RenameAccess[]): void {
    for (const event of events) {
      this.acceptPath(event.oldUri);
      this.acceptPath(event.newUri);
    }
  }

  public setFocused(focused: boolean): void {
    if (this.disposed) return;
    if (!focused) {
      if (this.interval !== undefined) this.scheduler.clearInterval(this.interval);
      this.interval = undefined;
      return;
    }
    if (this.interval !== undefined) return;
    void this.tick();
    this.interval = this.scheduler.setInterval(() => void this.tick(), this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  public async tick(): Promise<void> {
    if (this.disposed || this.pollRunning) return;
    this.pollRunning = true;
    try {
      const activeRoots = new Set(this.registry.repositories.map(({ root }) => root));
      for (const root of this.fingerprints.keys()) {
        if (!activeRoots.has(root)) this.fingerprints.delete(root);
      }
      await Promise.all(this.registry.repositories.map(async (entry) => this.checkFingerprint(entry)));
    } finally {
      this.pollRunning = false;
    }
  }

  public async refreshAll(reason = 'manual'): Promise<void> {
    await Promise.all(this.registry.repositories.map(async (entry) => {
      try {
        await entry.analyzer.refresh(reason);
      } catch (error) {
        this.options.onError?.(error, reason, entry.root);
      }
    }));
  }

  public retryIdentity(): Promise<void> {
    return this.refreshAll('identity');
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timeout !== undefined) this.scheduler.clearTimeout(this.timeout);
    if (this.interval !== undefined) this.scheduler.clearInterval(this.interval);
    this.timeout = undefined;
    this.interval = undefined;
    this.pendingPaths.clear();
    this.fingerprints.clear();
  }

  private acceptPath(uri: UriAccess): void {
    if (this.disposed) return;
    const entry = this.registry.findByUri(uri);
    if (entry === undefined) return;
    const path = relativePath(entry.root, uri.fsPath);
    if (path === undefined || path.length === 0) return;
    const paths = this.pendingPaths.get(entry) ?? new Set<string>();
    paths.add(path);
    this.pendingPaths.set(entry, paths);
    if (this.timeout !== undefined) this.scheduler.clearTimeout(this.timeout);
    this.timeout = this.scheduler.setTimeout(
      () => void this.flushPendingPaths(),
      this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    );
  }

  private async flushPendingPaths(): Promise<void> {
    this.timeout = undefined;
    const pending = [...this.pendingPaths];
    this.pendingPaths.clear();
    const active = new Set(this.registry.repositories);
    await Promise.all(pending.map(async ([entry, paths]) => {
      if (!active.has(entry)) return;
      try {
        await entry.analyzer.refresh('working-tree', [...paths].sort());
      } catch (error) {
        this.options.onError?.(error, 'working-tree', entry.root);
      }
    }));
  }

  private async checkFingerprint(entry: RegisteredRepository): Promise<void> {
    try {
      const fingerprint = await entry.repository.getFingerprint();
      const previous = this.fingerprints.get(entry.root);
      if (previous === undefined) {
        this.fingerprints.set(entry.root, fingerprint);
        return;
      }
      if (previous.head !== fingerprint.head) {
        await entry.analyzer.refresh('head');
        this.fingerprints.set(entry.root, fingerprint);
        return;
      }
      if (previous.status !== fingerprint.status) {
        const changes = await entry.repository.getWorkingChanges();
        const paths = [...new Set(changes.flatMap(({ path, originalPath }) =>
          originalPath === undefined ? [path] : [path, originalPath]
        ))].sort();
        await entry.analyzer.refresh('working-tree', paths);
      }
      this.fingerprints.set(entry.root, fingerprint);
    } catch (error) {
      this.options.onError?.(error, 'fingerprint', entry.root);
    }
  }
}

function relativePath(root: string, path: string): string | undefined {
  const candidate = relative(root, path);
  if (candidate === '' || candidate.startsWith('..') || isAbsolute(candidate)) return undefined;
  return sep === '/' ? candidate : candidate.split(sep).join('/');
}
