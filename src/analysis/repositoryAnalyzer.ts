import { open, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  hasConfiguredIdentity, matchesIdentity, normalizeEmail, normalizeIdentityPart
} from '../core/identity.js';
import type {
  CommitSummary,
  FileKind,
  FileRecord,
  GitIdentity,
  OwnedRange,
  RepositorySnapshot
} from '../core/model.js';
import { collapseOwnedLines } from '../core/ranges.js';
import { GitCommandError } from '../git/gitRunner.js';
import type { BlameLine, WorkingChange } from '../git/parsers.js';
import type { UserIndex } from '../git/repository.js';
import {
  hashRepositoryRoot,
  type CachedRepositoryIndex,
  type CacheIndexKey,
  type CacheStore
} from './cacheStore.js';

export type AnalysisPriority = 'active-editor' | 'explorer' | 'background';
export type RefreshReason = 'initialize' | 'working-tree' | 'head' | 'identity' | 'manual' | string;

export interface RepositoryAccess {
  readonly root: string;
  getGlobalIdentity(): Promise<GitIdentity>;
  getHead(): Promise<string | undefined>;
  getUserIndex(identity: GitIdentity): Promise<UserIndex>;
  getWorkingChanges(): Promise<WorkingChange[]>;
  blame(path: string): Promise<BlameLine[]>;
}

export interface AnalyzerDisposable {
  dispose(): void;
}

interface Candidate {
  readonly relativePath: string;
  readonly introducedByUser: boolean;
  readonly touchedByUser: boolean;
  readonly history: readonly CommitSummary[];
  readonly untracked: boolean;
  exists: boolean;
  working: boolean;
  binary: boolean;
  ranges: readonly OwnedRange[];
  resolvedGeneration?: number;
  failedGeneration?: number;
  failure?: unknown;
}

interface MutableCandidate {
  relativePath: string;
  introducedByUser: boolean;
  touchedByUser: boolean;
  history: CommitSummary[];
  untracked: boolean;
  exists: boolean;
  working: boolean;
  binary: boolean;
  ranges: readonly OwnedRange[];
  resolvedGeneration?: number;
  failedGeneration?: number;
  failure?: unknown;
}

export type AnalysisErrorReporter = (
  error: unknown, operation: 'blame', path: string
) => void;

interface AnalysisJob {
  readonly generation: number;
  readonly key: string;
  readonly candidate: Candidate;
  readonly promise: Promise<FileRecord | undefined>;
  readonly resolve: (value: FileRecord | undefined) => void;
  readonly reject: (reason: unknown) => void;
  priority: AnalysisPriority;
  sequence: number;
  active: boolean;
}

export interface AnalyzerFileHandle {
  read(
    buffer: Buffer, offset: number, length: number, position: number | null
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface AnalyzerFileSystem {
  stat(path: string): Promise<{ isFile(): boolean }>;
  open(path: string): Promise<AnalyzerFileHandle>;
}

const nodeFileSystem: AnalyzerFileSystem = {
  stat: async (path) => stat(path),
  open: async (path) => {
    const handle = await open(path, 'r');
    return {
      read: async (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: async () => handle.close()
    };
  }
};

export class RepositoryAnalyzer {
  public readonly reportsErrors = true;
  private readonly listeners = new Set<(snapshot: RepositorySnapshot) => void>();
  private readonly inFlight = new Map<string, AnalysisJob>();
  private readonly queuedJobs: AnalysisJob[] = [];
  private readonly retargetedJobs: AnalysisJob[] = [];
  private readonly pendingJobs = new Map<number, number>();
  private readonly indexLoads = new Map<string, Promise<Map<string, MutableCandidate>>>();
  private indexLoadTail: Promise<void> = Promise.resolve();
  private indexedCandidates = new Map<string, MutableCandidate>();
  private indexCacheKey: string | undefined;
  private candidates = new Map<string, Candidate>();
  private identity: GitIdentity = { name: '', email: '' };
  private head = '';
  private generation = 0;
  private activeJobs = 0;
  private nextJobSequence = 0;
  private disposed = false;
  private snapshot: RepositorySnapshot;

  public constructor(
    private readonly repository: RepositoryAccess,
    private readonly cacheStore: CacheStore,
    private readonly onError?: AnalysisErrorReporter,
    private readonly fileSystem: AnalyzerFileSystem = nodeFileSystem
  ) {
    this.snapshot = this.createSnapshot(false);
  }

  public readonly onDidChange = (
    listener: (snapshot: RepositorySnapshot) => void
  ): AnalyzerDisposable => {
    if (this.disposed) return { dispose: () => undefined };
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  public initialize(): Promise<void> {
    return this.refresh('initialize');
  }

  public async refresh(_reason: RefreshReason, paths?: readonly string[]): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.dropQueuedJobsBefore(generation);
    try {
      await this.refreshGeneration(generation, paths);
    } catch (error) {
      if (generation === this.generation) {
        this.settleRetargetedJobs();
        this.publish(false);
      }
      throw error;
    }
  }

  private async refreshGeneration(
    generation: number,
    paths: readonly string[] | undefined
  ): Promise<void> {
    const identity = await this.repository.getGlobalIdentity();
    if (generation !== this.generation) return;
    if (!hasConfiguredIdentity(identity)) {
      this.indexedCandidates = new Map();
      this.indexCacheKey = undefined;
      this.identity = identity;
      this.head = '';
      this.candidates = new Map();
      this.settleRetargetedJobs();
      this.publish(false);
      return;
    }

    const [head, workingChanges] = await Promise.all([
      this.repository.getHead(),
      this.repository.getWorkingChanges()
    ]);
    if (generation !== this.generation) return;

    let indexedCandidates: Map<string, MutableCandidate>;
    let cacheKeyText: string | undefined;
    if (head === undefined) {
      indexedCandidates = new Map();
    } else {
      const cacheKey = createCacheKey(this.repository.root, head, identity);
      cacheKeyText = JSON.stringify(cacheKey);
      if (this.indexCacheKey === cacheKeyText) {
        indexedCandidates = cloneCandidates(this.indexedCandidates);
      } else {
        indexedCandidates = await this.loadIndexedCandidates(cacheKey, identity);
        if (generation !== this.generation) return;
      }
    }

    const candidates = cloneCandidates(indexedCandidates);
    overlayWorkingChanges(candidates, workingChanges);
    await forEachConcurrent([...candidates.values()], 16, async (candidate) => {
      candidate.exists = await pathExists(this.absolutePath(candidate.relativePath), this.fileSystem);
    });
    if (generation !== this.generation) return;

    if (cacheKeyText !== undefined && cacheKeyText === this.indexCacheKey) {
      const invalidatedPaths = paths === undefined
        ? undefined
        : new Set(paths.map(normalizeRelativePath));
      for (const [path, candidate] of candidates) {
        const previous = this.candidates.get(path);
        if (previous?.resolvedGeneration === undefined && previous?.failedGeneration === undefined) continue;
        candidate.binary = previous.binary;
        candidate.ranges = previous.ranges;
        if (
          previous.resolvedGeneration !== undefined
          && invalidatedPaths !== undefined
          && !invalidatedPaths.has(path)
          && previous.exists === candidate.exists
          && previous.working === candidate.working
        ) {
          candidate.resolvedGeneration = generation;
        }
      }
    }

    this.indexedCandidates = cloneCandidates(indexedCandidates);
    this.indexCacheKey = cacheKeyText;
    this.identity = identity;
    this.head = head ?? '';
    this.candidates = candidates;
    this.publish(true);
    this.requeueRetargetedJobs(generation);

    for (const candidate of candidates.values()) {
      if (candidate.exists) {
        void this.ensureFile(candidate.relativePath, 'background').catch(() => undefined);
      }
    }
    if (!this.isScanning(generation)) this.publish(false);
  }

  private loadIndexedCandidates(
    cacheKey: CacheIndexKey,
    identity: GitIdentity
  ): Promise<Map<string, MutableCandidate>> {
    const key = JSON.stringify(cacheKey);
    const existing = this.indexLoads.get(key);
    if (existing !== undefined) return existing;

    const load = this.indexLoadTail.then(() => this.disposed
      ? new Map<string, MutableCandidate>()
      : this.readIndexedCandidates(cacheKey, identity)
    );
    this.indexLoadTail = load.then(() => undefined, () => undefined);
    this.indexLoads.set(key, load);
    const clear = (): void => {
      if (this.indexLoads.get(key) === load) this.indexLoads.delete(key);
    };
    void load.then(clear, clear);
    return load;
  }

  private async readIndexedCandidates(
    cacheKey: CacheIndexKey,
    identity: GitIdentity
  ): Promise<Map<string, MutableCandidate>> {
    const cached = await this.cacheStore.loadIndex(cacheKey);
    if (cached !== undefined) return candidatesFromCache(cached);

    const index = await this.repository.getUserIndex(identity);
    const candidates = buildCandidates(index, identity);
    await this.cacheStore.saveIndex(cacheKey, indexForCache(candidates));
    return candidates;
  }

  public ensureFile(
    relativePath: string,
    priority: AnalysisPriority
  ): Promise<FileRecord | undefined> {
    if (this.disposed) return Promise.resolve(this.getFile(relativePath));
    const normalizedPath = normalizeRelativePath(relativePath);
    const candidate = this.candidates.get(normalizedPath);
    if (candidate === undefined) return Promise.resolve(undefined);
    if (candidate.resolvedGeneration === this.generation) return Promise.resolve(toFileRecord(candidate));
    if (candidate.failedGeneration === this.generation) return Promise.reject(candidate.failure);

    const key = `${this.generation}\0${normalizedPath}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      if (!existing.active && priorityRank(priority) < priorityRank(existing.priority)) {
        existing.priority = priority;
        this.sortQueue();
      }
      return existing.promise;
    }

    const generation = this.generation;
    let resolveJob: ((value: FileRecord | undefined) => void) | undefined;
    let rejectJob: ((reason: unknown) => void) | undefined;
    const promise = new Promise<FileRecord | undefined>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job: AnalysisJob = {
      generation,
      key,
      candidate,
      promise,
      resolve: (value) => resolveJob?.(value),
      reject: (reason) => rejectJob?.(reason),
      priority,
      sequence: this.nextJobSequence++,
      active: false
    };
    this.inFlight.set(key, job);
    this.queuedJobs.push(job);
    this.pendingJobs.set(generation, (this.pendingJobs.get(generation) ?? 0) + 1);
    this.sortQueue();
    this.pumpQueue();
    return promise;
  }

  private pumpQueue(): void {
    if (this.disposed) return;
    while (this.activeJobs < 4) {
      const job = this.queuedJobs.shift();
      if (job === undefined) return;
      if (job.generation !== this.generation) {
        this.settleQueuedJob(job);
        continue;
      }
      job.active = true;
      this.activeJobs += 1;
      void this.analyzeCandidate(job.candidate, job.generation)
        .then(job.resolve, (error: unknown) => {
          if (job.generation === this.generation) {
            job.candidate.failedGeneration = job.generation;
            job.candidate.failure = error;
            this.onError?.(error, 'blame', job.candidate.relativePath);
          }
          job.reject(error);
        })
        .finally(() => {
          if (this.inFlight.get(job.key) === job) this.inFlight.delete(job.key);
          this.activeJobs -= 1;
          this.decrementPending(job.generation);
          if (job.generation === this.generation) this.publish(this.isScanning(job.generation));
          this.pumpQueue();
        });
    }
  }

  private dropQueuedJobsBefore(generation: number): void {
    for (let index = this.queuedJobs.length - 1; index >= 0; index -= 1) {
      const job = this.queuedJobs[index];
      if (job !== undefined && job.generation < generation) {
        this.queuedJobs.splice(index, 1);
        this.retainOrSettleQueuedJob(job);
      }
    }
  }

  private settleQueuedJob(job: AnalysisJob): void {
    if (this.inFlight.get(job.key) === job) this.inFlight.delete(job.key);
    this.decrementPending(job.generation);
    job.resolve(toFileRecord(job.candidate));
  }

  private retainOrSettleQueuedJob(job: AnalysisJob): void {
    if (this.inFlight.get(job.key) === job) this.inFlight.delete(job.key);
    this.decrementPending(job.generation);
    if (job.priority === 'background') {
      job.resolve(toFileRecord(job.candidate));
    } else {
      this.retargetedJobs.push(job);
    }
  }

  private requeueRetargetedJobs(generation: number): void {
    if (generation !== this.generation) return;
    const previousJobs = this.retargetedJobs.splice(0);
    for (const previousJob of previousJobs) {
      const relativePath = previousJob.candidate.relativePath;
      const candidate = this.candidates.get(relativePath);
      if (candidate === undefined) {
        previousJob.resolve(undefined);
        continue;
      }
      if (candidate.resolvedGeneration === generation) {
        previousJob.resolve(toFileRecord(candidate));
        continue;
      }

      const key = `${generation}\0${relativePath}`;
      const existing = this.inFlight.get(key);
      if (existing !== undefined) {
        if (
          !existing.active
          && priorityRank(previousJob.priority) < priorityRank(existing.priority)
        ) {
          existing.priority = previousJob.priority;
        }
        void existing.promise.then(previousJob.resolve, previousJob.reject);
        continue;
      }

      const job: AnalysisJob = {
        generation,
        key,
        candidate,
        promise: previousJob.promise,
        resolve: previousJob.resolve,
        reject: previousJob.reject,
        priority: previousJob.priority,
        sequence: this.nextJobSequence++,
        active: false
      };
      this.inFlight.set(key, job);
      this.queuedJobs.push(job);
      this.pendingJobs.set(generation, (this.pendingJobs.get(generation) ?? 0) + 1);
    }
    this.sortQueue();
    this.pumpQueue();
  }

  private settleRetargetedJobs(): void {
    const jobs = this.retargetedJobs.splice(0);
    for (const job of jobs) {
      job.resolve(this.getFile(job.candidate.relativePath));
    }
  }

  private decrementPending(generation: number): void {
    const current = this.pendingJobs.get(generation);
    if (current === undefined) return;
    const pending = current - 1;
    if (pending === 0) this.pendingJobs.delete(generation);
    else this.pendingJobs.set(generation, pending);
  }

  private sortQueue(): void {
    this.queuedJobs.sort((left, right) =>
      priorityRank(left.priority) - priorityRank(right.priority)
      || left.sequence - right.sequence
    );
  }

  private isScanning(generation = this.generation): boolean {
    return (this.pendingJobs.get(generation) ?? 0) > 0;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    const jobs = new Set([
      ...this.inFlight.values(),
      ...this.queuedJobs,
      ...this.retargetedJobs
    ]);
    this.inFlight.clear();
    this.queuedJobs.splice(0);
    this.retargetedJobs.splice(0);
    this.pendingJobs.clear();
    this.indexLoads.clear();
    for (const job of jobs) {
      job.resolve(this.getFile(job.candidate.relativePath));
    }
    this.snapshot = this.createSnapshot(false);
    this.listeners.clear();
  }

  public getSnapshot(): RepositorySnapshot {
    return this.snapshot;
  }

  public getFile(relativePath: string): FileRecord | undefined {
    const candidate = this.candidates.get(normalizeRelativePath(relativePath));
    return candidate === undefined ? undefined : toFileRecord(candidate);
  }

  private async analyzeCandidate(
    candidate: Candidate,
    generation: number
  ): Promise<FileRecord | undefined> {
    if (generation !== this.generation) return this.getFile(candidate.relativePath);
    let inspection: FileInspection;
    try {
      inspection = await inspectFile(this.absolutePath(candidate.relativePath), candidate.untracked, this.fileSystem);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      if (generation !== this.generation) return this.getFile(candidate.relativePath);
      candidate.exists = false;
      candidate.binary = false;
      candidate.ranges = [];
      candidate.failedGeneration = undefined;
      candidate.failure = undefined;
      candidate.resolvedGeneration = generation;
      this.publish(this.isScanning(generation));
      return toFileRecord(candidate);
    }

    if (generation !== this.generation) return this.getFile(candidate.relativePath);

    if (inspection.binary) {
      if (generation !== this.generation) return this.getFile(candidate.relativePath);
      candidate.binary = true;
      candidate.ranges = [];
      candidate.failedGeneration = undefined;
      candidate.failure = undefined;
      candidate.resolvedGeneration = generation;
      this.publish(this.isScanning(generation));
      return toFileRecord(candidate);
    }

    let ranges: readonly OwnedRange[];
    let blameReportedBinary = false;
    if (candidate.untracked) {
      ranges = [{ start: 0, endExclusive: inspection.lineCount ?? 1, uncommitted: true }];
    } else {
      try {
        const lines = await this.repository.blame(candidate.relativePath);
        ranges = collapseOwnedLines(lines.filter((line) =>
          line.uncommitted
          || (line.commit !== undefined && matchesIdentity(
            this.identity,
            line.commit.authorName,
            line.commit.authorEmail
          ))
        ));
      } catch (error) {
        if (!isExpectedBlameFailure(error)) throw error;
        blameReportedBinary = isBinaryBlameFailure(error);
        ranges = [];
      }
    }

    if (generation !== this.generation) return this.getFile(candidate.relativePath);
    candidate.binary = blameReportedBinary;
    candidate.ranges = ranges;
    candidate.failedGeneration = undefined;
    candidate.failure = undefined;
    candidate.resolvedGeneration = generation;
    this.publish(this.isScanning(generation));
    return toFileRecord(candidate);
  }

  private absolutePath(relativePath: string): string {
    const absolutePath = resolve(this.repository.root, relativePath);
    const relativeToRoot = relative(this.repository.root, absolutePath);
    if (isParentTraversal(relativeToRoot) || isAbsolute(relativeToRoot)) {
      throw new Error('path is outside the repository');
    }
    return absolutePath;
  }

  private publish(scanning: boolean): void {
    if (this.disposed) return;
    this.snapshot = this.createSnapshot(scanning);
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private createSnapshot(scanning: boolean): RepositorySnapshot {
    const files = [...this.candidates.values()]
      .map(toFileRecord)
      .filter((file): file is FileRecord => file !== undefined)
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return {
      root: this.repository.root,
      head: this.head,
      identity: this.identity,
      files,
      scanning,
      generatedAt: Date.now()
    };
  }
}

function buildCandidates(index: UserIndex, identity: GitIdentity): Map<string, MutableCandidate> {
  const candidates = new Map<string, MutableCandidate>();
  for (const entry of index.entries) {
    if (!matchesIdentity(identity, entry.commit.authorName, entry.commit.authorEmail)) continue;
    for (const change of entry.changes) {
      const relativePath = normalizeRelativePath(change.path);
      const candidate = candidates.get(relativePath) ?? newCandidate(relativePath);
      candidate.touchedByUser = true;
      candidate.introducedByUser ||= change.status.trim() === 'A';
      if (!candidate.history.some(({ hash }) => hash === entry.commit.hash)) {
        candidate.history.push(entry.commit);
      }
      candidates.set(relativePath, candidate);
    }
  }
  return candidates;
}

function createCacheKey(root: string, head: string, identity: GitIdentity): CacheIndexKey {
  return {
    rootHash: hashRepositoryRoot(root),
    head,
    normalizedIdentity: JSON.stringify([
      normalizeIdentityPart(identity.name),
      normalizeEmail(identity.email)
    ])
  };
}

function indexForCache(candidates: ReadonlyMap<string, MutableCandidate>): CachedRepositoryIndex {
  const commits = new Map<string, CommitSummary>();
  const files = [...candidates.values()].map((candidate) => {
    for (const commit of candidate.history) commits.set(commit.hash, commit);
    return {
      relativePath: candidate.relativePath,
      introducedByUser: candidate.introducedByUser,
      commitHashes: candidate.history.map(({ hash }) => hash)
    };
  });
  return { commits: [...commits.values()], files };
}

function candidatesFromCache(index: CachedRepositoryIndex): Map<string, MutableCandidate> {
  const commits = new Map(index.commits.map((commit) => [commit.hash, commit]));
  return new Map(index.files.map((file) => {
    const candidate = newCandidate(normalizeRelativePath(file.relativePath));
    candidate.touchedByUser = true;
    candidate.introducedByUser = file.introducedByUser;
    candidate.history = file.commitHashes.flatMap((hash) => {
      const commit = commits.get(hash);
      return commit === undefined ? [] : [commit];
    });
    return [candidate.relativePath, candidate];
  }));
}

function cloneCandidates(
  candidates: ReadonlyMap<string, Candidate>
): Map<string, MutableCandidate> {
  return new Map([...candidates].map(([path, candidate]) => [path, {
    relativePath: candidate.relativePath,
    introducedByUser: candidate.introducedByUser,
    touchedByUser: candidate.touchedByUser,
    history: [...candidate.history],
    untracked: false,
    exists: false,
    working: false,
    binary: false,
    ranges: []
  }]));
}

function overlayWorkingChanges(
  candidates: Map<string, MutableCandidate>,
  changes: readonly WorkingChange[]
): void {
  for (const change of changes) {
    const relativePath = normalizeRelativePath(change.path);
    const candidate = candidates.get(relativePath) ?? newCandidate(relativePath);
    candidate.touchedByUser = true;
    candidate.working = true;
    candidate.untracked = change.status === '?';
    candidate.introducedByUser ||= change.status === '?' || change.status.includes('A');
    candidates.set(relativePath, candidate);

    if (change.originalPath !== undefined) {
      const originalPath = normalizeRelativePath(change.originalPath);
      const original = candidates.get(originalPath) ?? newCandidate(originalPath);
      original.touchedByUser = true;
      original.working = true;
      candidates.set(originalPath, original);
    }
  }
}

function newCandidate(relativePath: string): MutableCandidate {
  return {
    relativePath,
    introducedByUser: false,
    touchedByUser: false,
    history: [],
    untracked: false,
    exists: false,
    working: false,
    binary: false,
    ranges: []
  };
}

function toFileRecord(candidate: Candidate): FileRecord | undefined {
  const kind = classify({
    exists: candidate.exists,
    introducedByUser: candidate.introducedByUser,
    working: candidate.working,
    hasOwnedLines: candidate.ranges.length > 0,
    touchedByUser: candidate.touchedByUser
  });
  return kind === undefined ? undefined : {
    relativePath: candidate.relativePath,
    kind,
    exists: candidate.exists,
    working: candidate.working,
    binary: candidate.binary,
    ranges: candidate.ranges,
    history: candidate.history
  };
}

function classify(input: {
  readonly exists: boolean;
  readonly introducedByUser: boolean;
  readonly working: boolean;
  readonly hasOwnedLines: boolean;
  readonly touchedByUser: boolean;
}): FileKind | undefined {
  if (!input.exists) return input.touchedByUser ? 'past' : undefined;
  if (input.introducedByUser) return 'added';
  if (input.working || input.hasOwnedLines) return 'modified';
  return input.touchedByUser ? 'past' : undefined;
}

function priorityRank(priority: AnalysisPriority): number {
  switch (priority) {
    case 'active-editor':
      return 0;
    case 'explorer':
      return 1;
    case 'background':
      return 2;
  }
}

function normalizeRelativePath(path: string): string {
  const normalized = process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
  return normalized.replace(/^\.\//, '');
}

function isParentTraversal(path: string): boolean {
  return path === '..' || path.startsWith(`..${sep}`);
}

async function pathExists(path: string, fileSystem: AnalyzerFileSystem): Promise<boolean> {
  try {
    return (await fileSystem.stat(path)).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

interface FileInspection {
  readonly binary: boolean;
  readonly lineCount?: number;
}

const FILE_HEADER_BYTES = 8 * 1024;
const FILE_STREAM_BYTES = 64 * 1024;

async function inspectFile(
  path: string, countLines: boolean, fileSystem: AnalyzerFileSystem
): Promise<FileInspection> {
  const handle = await fileSystem.open(path);
  try {
    const header = Buffer.allocUnsafe(FILE_HEADER_BYTES);
    let headerLength = 0;
    let lineCount = 1;
    while (headerLength < header.length) {
      const { bytesRead } = await handle.read(
        header, headerLength, header.length - headerLength, null
      );
      if (bytesRead === 0) break;
      if (countLines) lineCount += countLineFeeds(header, headerLength, headerLength + bytesRead);
      headerLength += bytesRead;
    }
    if (header.subarray(0, headerLength).includes(0)) return { binary: true };
    if (!countLines || headerLength < header.length) {
      return countLines ? { binary: false, lineCount } : { binary: false };
    }

    const chunk = Buffer.allocUnsafe(FILE_STREAM_BYTES);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      lineCount += countLineFeeds(chunk, 0, bytesRead);
    }
    return { binary: false, lineCount };
  } finally {
    await handle.close();
  }
}

function countLineFeeds(buffer: Buffer, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (buffer[index] === 0x0a) count += 1;
  }
  return count;
}

async function forEachConcurrent<T>(
  values: readonly T[], limit: number, operation: (value: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await operation(values[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isBinaryBlameFailure(error: unknown): boolean {
  return error instanceof GitCommandError && /binary/i.test(error.stderr);
}

function isExpectedBlameFailure(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false;
  return /binary|no such path|does not exist|cannot stat|pathspec/i.test(error.stderr);
}
