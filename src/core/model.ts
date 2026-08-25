export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export type FileKind = 'added' | 'modified' | 'past';

export interface CommitSummary {
  readonly hash: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: number;
  readonly subject: string;
}

export interface OwnedLine {
  readonly line: number;
  readonly commit?: CommitSummary;
  readonly uncommitted: boolean;
}

export interface OwnedRange {
  readonly start: number;
  readonly endExclusive: number;
  readonly commit?: CommitSummary;
  readonly uncommitted: boolean;
}

export interface FileRecord {
  readonly relativePath: string;
  readonly kind: FileKind;
  readonly exists: boolean;
  readonly working: boolean;
  readonly binary: boolean;
  readonly ranges: readonly OwnedRange[];
  readonly history: readonly CommitSummary[];
}

export interface RepositorySnapshot {
  readonly root: string;
  readonly head: string;
  readonly identity: GitIdentity;
  readonly files: readonly FileRecord[];
  readonly scanning: boolean;
  readonly generatedAt: number;
}
