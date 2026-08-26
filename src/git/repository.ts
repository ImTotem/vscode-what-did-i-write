import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { matchesIdentity } from '../core/identity.js';
import type { CommitSummary, GitIdentity } from '../core/model.js';
import { GitRunner } from './gitRunner.js';
import {
  parseHistoryRecords,
  parseLinePorcelainBlame,
  parseLogIndex,
  parsePorcelainV2Status,
  type BlameLine,
  type LogIndexEntry,
  type WorkingChange
} from './parsers.js';

const LOG_FORMAT = '--format=%x00%H%x00%an%x00%ae%x00%at%x00%s%x00';

export interface UserIndex {
  readonly commits: readonly CommitSummary[];
  readonly entries: readonly LogIndexEntry[];
}

export interface RepositoryFingerprint {
  readonly head: string | undefined;
  readonly status: string;
}

export interface FileHistoryEntry {
  readonly commit: CommitSummary;
  readonly path: string;
  readonly parentPath?: string;
}

export class GitRepository {
  private constructor(
    readonly root: string,
    private readonly runner: GitRunner
  ) {}

  public static async discover(startPath: string, runner = new GitRunner()): Promise<GitRepository> {
    const result = await runner.run(startPath, ['rev-parse', '--show-toplevel']);
    return new GitRepository(resolve(decodeLine(result.stdout)), runner);
  }

  public async getGlobalIdentity(): Promise<GitIdentity> {
    const [name, email] = await Promise.all([
      this.readOptionalGlobalConfig('user.name'),
      this.readOptionalGlobalConfig('user.email')
    ]);
    return { name, email };
  }

  public async getHead(): Promise<string | undefined> {
    const result = await this.runner.run(this.root, ['rev-parse', '--verify', 'HEAD'], {
      allowExitCodes: [0, 128]
    });
    return result.exitCode === 0 ? decodeLine(result.stdout) : undefined;
  }

  public async getUserIndex(identity: GitIdentity): Promise<UserIndex> {
    const result = await this.runner.run(this.root, [
      'log', 'HEAD', LOG_FORMAT, '--name-status', '-z', '--no-renames', '--diff-merges=first-parent'
    ]);
    const entries = parseLogIndex(result.stdout).filter(({ commit }) =>
      matchesIdentity(identity, commit.authorName, commit.authorEmail)
    );
    return { entries, commits: entries.map(({ commit }) => commit) };
  }

  public async getWorkingChanges(): Promise<WorkingChange[]> {
    const result = await this.readStatus();
    return parsePorcelainV2Status(result.stdout);
  }

  public async blame(path: string): Promise<BlameLine[]> {
    const result = await this.runner.run(this.root, [
      '--literal-pathspecs', 'blame', '--line-porcelain', '--', path
    ]);
    return parseLinePorcelainBlame(result.stdout.toString('utf8'));
  }

  public async getFileHistory(path: string): Promise<CommitSummary[]> {
    const result = await this.runner.run(this.root, [
      '--literal-pathspecs', 'log', 'HEAD', '-z', '--follow', LOG_FORMAT, '--', path
    ]);
    return parseHistoryRecords(result.stdout);
  }
  public async getFileHistoryEntries(path: string): Promise<FileHistoryEntry[]> {
    const result = await this.runner.run(this.root, [
      '--literal-pathspecs', 'log', 'HEAD', '--follow', LOG_FORMAT,
      '--name-status', '-z', '--find-renames', '--', path
    ]);
    let trackedPath = path;
    const history: FileHistoryEntry[] = [];
    for (const entry of parseLogIndex(result.stdout)) {
      const change = entry.changes.find(({ path: changedPath, originalPath }) =>
        changedPath === trackedPath || originalPath === trackedPath
      );
      if (change === undefined) continue;
      const renamed = /^[RC]\d*$/.test(change.status) && change.originalPath !== undefined;
      const parentPath = change.status === 'A'
        ? undefined
        : renamed
          ? change.originalPath
          : change.path;
      history.push({ commit: entry.commit, path: change.path, parentPath });
      if (renamed) trackedPath = change.originalPath as string;
    }
    return history;
  }


  public async mapWorkingLineToHead(path: string, line: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(line) || line < 1) {
      throw new RangeError('line must be a positive one-based integer');
    }
    const result = await this.runner.run(this.root, [
      '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-color', '--unified=0',
      'HEAD', '--', path
    ]);
    return mapWorkingLineThroughDiff(result.stdout.toString('utf8'), line);
  }

  public async getLineHistory(path: string, line: number): Promise<CommitSummary[]> {
    if (!Number.isSafeInteger(line) || line < 1) throw new RangeError('line must be a positive one-based integer');
    const result = await this.runner.run(this.root, [
      '--literal-pathspecs', 'log', 'HEAD', '-z', '--no-patch',
      '-L', `${line},${line}:${path}`, LOG_FORMAT
    ], { allowExitCodes: [0, 1, 128] });
    return result.exitCode === 0
      ? parseHistoryRecords(result.stdout)
      : [];
  }

  public async showFile(revision: string, path: string): Promise<Buffer | undefined> {
    const objectName = `${revision}:${path}`;
    const exists = await this.runner.run(this.root, ['cat-file', '-e', objectName], {
      allowExitCodes: [0, 128]
    });
    if (exists.exitCode === 128) return undefined;
    const result = await this.runner.run(this.root, [
      '--literal-pathspecs', 'show', objectName
    ]);
    return result.stdout;
  }

  public async getFingerprint(): Promise<RepositoryFingerprint> {
    const [head, status] = await Promise.all([this.getHead(), this.readStatus()]);
    const paths = [...new Set(parsePorcelainV2Status(status.stdout).flatMap(({ path, originalPath }) =>
      originalPath === undefined ? [path] : [path, originalPath]
    ))].sort();
    const pathFingerprints = await mapConcurrent(paths, 16, (path) => fingerprintPath(this.root, path));
    const fingerprint = createHash('sha256').update(status.stdout);
    for (let index = 0; index < paths.length; index += 1) {
      fingerprint.update('\0').update(paths[index] as string).update('\0').update(pathFingerprints[index] as string);
    }
    return {
      head,
      status: fingerprint.digest('hex')
    };
  }

  private async readOptionalGlobalConfig(key: string): Promise<string> {
    const result = await this.runner.run(this.root, ['config', '--global', '--get', key], {
      allowExitCodes: [0, 1]
    });
    return result.exitCode === 0 ? decodeLine(result.stdout) : '';
  }

  private readStatus() {
    return this.runner.run(this.root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  }
}

function decodeLine(bytes: Buffer): string {
  return bytes.toString('utf8').replace(/[\r\n]+$/, '');
}

export function mapWorkingLineThroughDiff(diff: string, workingLine: number): number | undefined {
  let headLine = workingLine;
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (let match = hunk.exec(diff); match !== null; match = hunk.exec(diff)) {
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (
      !Number.isSafeInteger(oldStart)
      || !Number.isSafeInteger(oldCount)
      || !Number.isSafeInteger(newStart)
      || !Number.isSafeInteger(newCount)
    ) continue;
    if (
      newCount > 0
      && workingLine >= newStart
      && workingLine < newStart + newCount
    ) {
      return undefined;
    }
    const followsHunk = newCount === 0
      ? workingLine > newStart
      : workingLine >= newStart + newCount;
    if (followsHunk) headLine += oldCount - newCount;
  }
  return headLine;
}

const FILE_SAMPLE_BYTES = 4 * 1024;

async function fingerprintPath(root: string, path: string): Promise<string> {
  const absolutePath = resolve(root, path);
  const relativeToRoot = relative(root, absolutePath);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
    throw new Error('fingerprint path is outside the repository');
  }
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) return 'missing';
    throw error;
  }
  const hash = createHash('sha256')
    .update(`${metadata.mode}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`);
  if (!metadata.isFile() || metadata.size === 0n) return hash.digest('hex');

  const handle = await open(absolutePath, 'r');
  try {
    const sampleLength = Number(metadata.size < BigInt(FILE_SAMPLE_BYTES) ? metadata.size : BigInt(FILE_SAMPLE_BYTES));
    const head = Buffer.allocUnsafe(sampleLength);
    const { bytesRead: headBytes } = await handle.read(head, 0, sampleLength, 0);
    hash.update(head.subarray(0, headBytes));
    if (metadata.size > BigInt(FILE_SAMPLE_BYTES) && metadata.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
      const tail = Buffer.allocUnsafe(FILE_SAMPLE_BYTES);
      const { bytesRead: tailBytes } = await handle.read(
        tail, 0, FILE_SAMPLE_BYTES, Number(metadata.size) - FILE_SAMPLE_BYTES
      );
      hash.update(tail.subarray(0, tailBytes));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[], limit: number, operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
