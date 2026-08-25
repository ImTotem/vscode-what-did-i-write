import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { matchesIdentity, normalizeEmail, normalizeIdentityPart } from '../core/identity.js';
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
}

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

export class RepositoryAnalyzer {
  private readonly listeners = new Set<(snapshot: RepositorySnapshot) => void>();
  private readonly inFlight = new Map<string, AnalysisJob>();
  private readonly queuedJobs: AnalysisJob[] = [];
  private readonly pendingJobs = new Map<number, number>();
  private indexedCandidates = new Map<string, MutableCandidate>();
  private indexCacheKey: string | undefined;
  private candidates = new Map<string, Candidate>();
  private identity: GitIdentity = { name: '', email: '' };
  private head = '';
  private generation = 0;
  private activeJobs = 0;
  private nextJobSequence = 0;
  private snapshot: RepositorySnapshot;

  public constructor(
    private readonly repository: RepositoryAccess,
    private readonly cacheStore: CacheStore
  ) {
    this.snapshot = this.createSnapshot(false);
  }

  public readonly onDidChange = (
    listener: (snapshot: RepositorySnapshot) => void
  ): AnalyzerDisposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  public initialize(): Promise<void> {
    return this.refresh('initialize');
  }

  public async refresh(_reason: RefreshReason, paths?: readonly string[]): Promise<void> {
    const generation = ++this.generation;
    const [identity, head, workingChanges] = await Promise.all([
      this.repository.getGlobalIdentity(),
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
        const cached = await this.cacheStore.loadIndex(cacheKey);
        if (generation !== this.generation) return;
        if (cached !== undefined) {
          indexedCandidates = candidatesFromCache(cached);
        } else {
          const index = await this.repository.getUserIndex(identity);
          if (generation !== this.generation) return;
          indexedCandidates = buildCandidates(index, identity);
          await this.cacheStore.saveIndex(cacheKey, indexForCache(indexedCandidates));
          if (generation !== this.generation) return;
        }
      }
    }

    const candidates = cloneCandidates(indexedCandidates);
    overlayWorkingChanges(candidates, workingChanges);
    await Promise.all([...candidates.values()].map(async (candidate) => {
      candidate.exists = await pathExists(this.absolutePath(candidate.relativePath));
    }));
    if (generation !== this.generation) return;

    if (cacheKeyText !== undefined && cacheKeyText === this.indexCacheKey && paths !== undefined) {
      const invalidatedPaths = new Set(paths.map(normalizeRelativePath));
      for (const [path, candidate] of candidates) {
        if (invalidatedPaths.has(path)) continue;
        const previous = this.candidates.get(path);
        if (
          previous?.resolvedGeneration !== undefined
          && previous.exists === candidate.exists
          && previous.working === candidate.working
        ) {
          candidate.binary = previous.binary;
          candidate.ranges = previous.ranges;
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

    for (const candidate of candidates.values()) {
      if (candidate.exists) {
        void this.ensureFile(candidate.relativePath, 'background').catch(() => undefined);
      }
    }
    if (!this.isScanning(generation)) this.publish(false);
  }

  public ensureFile(
    relativePath: string,
    priority: AnalysisPriority
  ): Promise<FileRecord | undefined> {
    const normalizedPath = normalizeRelativePath(relativePath);
    const candidate = this.candidates.get(normalizedPath);
    if (candidate === undefined) return Promise.resolve(undefined);
    if (candidate.resolvedGeneration === this.generation) return Promise.resolve(toFileRecord(candidate));

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
    while (this.activeJobs < 4) {
      const job = this.queuedJobs.shift();
      if (job === undefined) return;
      job.active = true;
      this.activeJobs += 1;
      void this.analyzeCandidate(job.candidate, job.generation)
        .then(job.resolve, job.reject)
        .finally(() => {
          if (this.inFlight.get(job.key) === job) this.inFlight.delete(job.key);
          this.activeJobs -= 1;
          const pending = (this.pendingJobs.get(job.generation) ?? 1) - 1;
          if (pending === 0) this.pendingJobs.delete(job.generation);
          else this.pendingJobs.set(job.generation, pending);
          if (job.generation === this.generation) this.publish(this.isScanning(job.generation));
          this.pumpQueue();
        });
    }
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
    let contents: Buffer;
    try {
      contents = await readFile(this.absolutePath(candidate.relativePath));
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      if (generation !== this.generation) return this.getFile(candidate.relativePath);
      candidate.exists = false;
      candidate.binary = false;
      candidate.ranges = [];
      candidate.resolvedGeneration = generation;
      this.publish(this.isScanning(generation));
      return toFileRecord(candidate);
    }

    const binary = contents.subarray(0, 8192).includes(0);
    if (binary) {
      if (generation !== this.generation) return this.getFile(candidate.relativePath);
      candidate.binary = true;
      candidate.ranges = [];
      candidate.resolvedGeneration = generation;
      this.publish(this.isScanning(generation));
      return toFileRecord(candidate);
    }

    let ranges: readonly OwnedRange[];
    let blameReportedBinary = false;
    if (candidate.untracked) {
      const lineCount = contents.toString('utf8').split(/\r?\n/).length;
      ranges = [{ start: 0, endExclusive: lineCount, uncommitted: true }];
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
    candidate.resolvedGeneration = generation;
    this.publish(this.isScanning(generation));
    return toFileRecord(candidate);
  }

  private absolutePath(relativePath: string): string {
    const absolutePath = resolve(this.repository.root, relativePath);
    const relativeToRoot = relative(this.repository.root, absolutePath);
    if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
      throw new Error('path is outside the repository');
    }
    return absolutePath;
  }

  private publish(scanning: boolean): void {
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
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
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
