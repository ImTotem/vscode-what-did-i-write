import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

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

const LOG_FORMAT = '--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s%x00';

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
      'log', 'HEAD', LOG_FORMAT, '--name-status', '-z', '--no-renames'
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
      '--literal-pathspecs', 'log', 'HEAD', '--follow', LOG_FORMAT, '--', path
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


  public async getLineHistory(path: string, line: number): Promise<CommitSummary[]> {
    if (!Number.isSafeInteger(line) || line < 1) throw new RangeError('line must be a positive one-based integer');
    const result = await this.runner.run(this.root, [
      '--literal-pathspecs', 'log', 'HEAD', '-L', `${line},${line}:${path}`, LOG_FORMAT
    ]);
    return parseHistoryRecords(result.stdout);
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
    return {
      head,
      status: createHash('sha256').update(status.stdout).digest('hex')
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
