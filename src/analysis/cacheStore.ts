import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';

import type { CommitSummary } from '../core/model.js';

export interface CacheIndexKey {
  readonly rootHash: string;
  readonly head: string;
  readonly normalizedIdentity: string;
}

export interface CachedIndexFile {
  readonly relativePath: string;
  readonly introducedByUser: boolean;
  readonly commitHashes: readonly string[];
}

export interface CachedRepositoryIndex {
  readonly commits: readonly CommitSummary[];
  readonly files: readonly CachedIndexFile[];
}

interface CacheEnvelope {
  readonly key: CacheIndexKey;
  readonly value: CachedRepositoryIndex;
}

export class CacheStore {
  private readonly storagePath: string | undefined;

  public constructor(storageUri: string | { readonly fsPath: string } | undefined) {
    this.storagePath = typeof storageUri === 'string' ? storageUri : storageUri?.fsPath;
  }

  public async loadIndex(key: CacheIndexKey): Promise<CachedRepositoryIndex | undefined> {
    if (this.storagePath === undefined) return undefined;
    try {
      const envelope: unknown = JSON.parse(await readFile(this.cachePath(key), 'utf8'));
      return isCacheEnvelope(envelope) && sameKey(envelope.key, key) ? envelope.value : undefined;
    } catch (error) {
      if (isMissingFileError(error) || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  public async saveIndex(key: CacheIndexKey, value: CachedRepositoryIndex): Promise<void> {
    if (this.storagePath === undefined) return;
    await mkdir(this.storagePath, { recursive: true });
    const envelope: CacheEnvelope = { key, value };
    await writeFile(this.cachePath(key), JSON.stringify(envelope), 'utf8');
  }

  public async clearRepository(repoRoot: string): Promise<void> {
    if (this.storagePath === undefined) return;
    let entries: string[];
    try {
      entries = await readdir(this.storagePath);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    const prefix = `${hashRepositoryRoot(repoRoot)}.`;
    await Promise.all(entries
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .map(async (name) => rm(resolve(this.storagePath as string, name), { force: true })));
  }

  private cachePath(key: CacheIndexKey): string {
    const keyHash = createHash('sha256')
      .update(key.head)
      .update('\0')
      .update(key.normalizedIdentity)
      .digest('hex');
    return resolve(this.storagePath as string, `${key.rootHash}.${keyHash}.json`);
  }
}

export function hashRepositoryRoot(repoRoot: string): string {
  const normalized = process.platform === 'win32'
    ? resolve(repoRoot).toLocaleLowerCase()
    : resolve(repoRoot);
  return createHash('sha256').update(normalized).digest('hex');
}

function sameKey(left: CacheIndexKey, right: CacheIndexKey): boolean {
  return left.rootHash === right.rootHash
    && left.head === right.head
    && left.normalizedIdentity === right.normalizedIdentity;
}

function isCacheEnvelope(value: unknown): value is CacheEnvelope {
  if (!isRecord(value) || !isCacheKey(value.key) || !isRecord(value.value)) return false;
  if (!Array.isArray(value.value.commits) || !value.value.commits.every(isCommitSummary)) return false;
  if (!Array.isArray(value.value.files) || !value.value.files.every(isCachedIndexFile)) return false;

  const commitHashes = new Set(value.value.commits.map((commit) => commit.hash));
  if (commitHashes.size !== value.value.commits.length) return false;
  const paths = new Set(value.value.files.map((file) => file.relativePath));
  return paths.size === value.value.files.length
    && value.value.files.every((file) =>
      file.commitHashes.length > 0
      && new Set(file.commitHashes).size === file.commitHashes.length
      && file.commitHashes.every((hash) => commitHashes.has(hash))
    );
}

function isCacheKey(value: unknown): value is CacheIndexKey {
  return isRecord(value)
    && typeof value.rootHash === 'string'
    && typeof value.head === 'string'
    && typeof value.normalizedIdentity === 'string';
}

function isCommitSummary(value: unknown): value is CommitSummary {
  return isRecord(value)
    && typeof value.hash === 'string'
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.hash)
    && typeof value.authorName === 'string'
    && typeof value.authorEmail === 'string'
    && typeof value.authoredAt === 'number'
    && Number.isSafeInteger(value.authoredAt)
    && typeof value.subject === 'string';
}

function isCachedIndexFile(value: unknown): value is CachedIndexFile {
  return isRecord(value)
    && typeof value.relativePath === 'string'
    && isSafeNormalizedRelativePath(value.relativePath)
    && typeof value.introducedByUser === 'boolean'
    && Array.isArray(value.commitHashes)
    && value.commitHashes.every((hash) => typeof hash === 'string');
}

function isSafeNormalizedRelativePath(value: string): boolean {
  return value.length > 0
    && !value.includes('\0')
    && !value.includes('\\')
    && !posix.isAbsolute(value)
    && !win32.isAbsolute(value)
    && posix.normalize(value) === value
    && value !== '.'
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
