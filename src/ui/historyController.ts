import { basename, isAbsolute, join, relative, sep } from 'node:path';

import * as vscode from 'vscode';

import { matchesIdentity } from '../core/identity.js';
import type { CommitSummary, GitIdentity, OwnedRange } from '../core/model.js';
import type { RegisteredRepository, RepositoryRegistry } from '../extension/repositoryRegistry.js';
import type { WorkingChange } from '../git/parsers.js';
import type { FileHistoryEntry } from '../git/repository.js';
import { revisionUri } from './gitContentProvider.js';
import type { HistoryTreeNode } from './myCodeTree.js';

const EMPTY_REVISION = '0000000';
type HistoryOpenMode = 'preview' | 'pinned';


interface HistoryRepository {
  getFileHistory(path: string): Promise<CommitSummary[]>;
  getFileHistoryEntries?(path: string): Promise<FileHistoryEntry[]>;
  mapWorkingLineToHead?(path: string, line: number): Promise<number | undefined>;
  getLineHistory(path: string, line: number): Promise<CommitSummary[]>;
  getWorkingChanges(): Promise<WorkingChange[]>;
}

export interface CommitHistoryQuickPickItem extends vscode.QuickPickItem {
  readonly itemType: 'commit';
  readonly commit: CommitSummary;
  readonly path: string;
  readonly parentPath?: string;
}

export interface WorkingHistoryQuickPickItem extends vscode.QuickPickItem {
  readonly itemType: 'working';
  readonly headPath: string;
  readonly workingPath: string;
  readonly exists: boolean;
  readonly headExists: boolean;
}

export type HistoryQuickPickItem = CommitHistoryQuickPickItem | WorkingHistoryQuickPickItem;
export interface HistoryPreview {
  readonly ownedRange: OwnedRange;
  readonly fileHistory: readonly CommitSummary[];
  readonly lineHistory: readonly CommitSummary[];
}

export type TimelineMode = 'file' | 'line';

export interface WorkingTimelineEntry {
  readonly id: 'working';
  readonly kind: 'working';
  readonly title: string;
  readonly detail: string;
  readonly headPath: string;
  readonly workingPath: string;
  readonly exists: boolean;
  readonly headExists: boolean;
}

export interface CommitTimelineEntry {
  readonly id: string;
  readonly kind: 'commit';
  readonly title: string;
  readonly relativeDate: string;
  readonly authoredAt: number;
  readonly latest: boolean;
  readonly commit: CommitSummary;
  readonly path: string;
  readonly parentPath?: string;
}

export type HistoryTimelineEntry = WorkingTimelineEntry | CommitTimelineEntry;

export interface HistoryTimelineModel {
  readonly root: string;
  readonly head: string;
  readonly sourcePath: string;
  readonly sourceExists: boolean;
  readonly relativePath: string;
  readonly mode: TimelineMode;
  readonly line?: number;
  readonly commitLine?: number;
  readonly entries: readonly HistoryTimelineEntry[];
}


export interface CommitDiffTarget {
  readonly root: string;
  readonly relativePath: string;
  readonly commit: CommitSummary;
  readonly path?: string;
  readonly parentPath?: string;
  readonly line?: number;
}

export function commitQuickPickItems(
  history: readonly (CommitSummary | FileHistoryEntry)[],
  identity: GitIdentity,
  fallbackPath: string,
  now = Date.now()
): CommitHistoryQuickPickItem[] {
  return history
    .map((value) => isHistoryEntry(value)
      ? value
      : { commit: value, path: fallbackPath, parentPath: fallbackPath })
    .filter(({ commit }) => matchesIdentity(identity, commit.authorName, commit.authorEmail))
    .sort((left, right) => right.commit.authoredAt - left.commit.authoredAt)
    .map(({ commit, path, parentPath }) => ({
      itemType: 'commit' as const,
      label: commit.subject,
      description: `${relativeDate(commit.authoredAt, now)} · ${commit.hash.slice(0, 7)}`,
      detail: `${commit.authorName} <${commit.authorEmail}> · ${new Date(commit.authoredAt * 1_000).toLocaleString()} · ${path}`,
      commit,
      path,
      parentPath
    }));
}

export class HistoryController {
  private readonly previewCache = new Map<string, HistoryPreview>();
  public constructor(
    private readonly registry: RepositoryRegistry,
    private readonly now: () => number = Date.now
  ) {}

  public async getHistoryPreview(
    input: unknown,
    zeroBasedLine: number,
    cancellation?: Pick<vscode.CancellationToken, 'isCancellationRequested'>
  ): Promise<HistoryPreview | undefined> {
    const cancelled = (): boolean => cancellation?.isCancellationRequested === true;
    if (cancelled() || !Number.isSafeInteger(zeroBasedLine) || zeroBasedLine < 0) return undefined;
    const target = this.resolveTarget(input);
    if (target === undefined || cancelled()) return undefined;
    const snapshot = target.entry.analyzer.getSnapshot();
    const record = snapshot.files.find(({ relativePath }) => relativePath === target.path);
    const ownedRange = record?.ranges.find(({ start, endExclusive }) =>
      start <= zeroBasedLine && zeroBasedLine < endExclusive);
    if (ownedRange === undefined || cancelled()) return undefined;
    const cacheKey = [target.root, snapshot.head, snapshot.generatedAt, target.path, zeroBasedLine].join('\0');
    const cached = this.previewCache.get(cacheKey);
    if (cached !== undefined) return cancelled() ? undefined : cached;

    const repository = historyRepository(target.entry);
    const working = await currentChangeItem(repository, target.root, target.path);
    if (cancelled()) return undefined;
    const historyPath = working?.headPath ?? target.path;
    const headLine = working !== undefined && repository.mapWorkingLineToHead !== undefined
      ? await repository.mapWorkingLineToHead(working.workingPath, zeroBasedLine + 1)
      : zeroBasedLine + 1;
    if (cancelled()) return undefined;
    const lineHistory = working?.headExists === false || headLine === undefined
      ? []
      : await repository.getLineHistory(historyPath, headLine);
    if (cancelled()) return undefined;
    const preview: HistoryPreview = {
      ownedRange,
      fileHistory: userCommits(record?.history ?? [], target.identity),
      lineHistory: userCommits(lineHistory, target.identity)
    };
    if (this.previewCache.size >= 100) this.previewCache.clear();
    this.previewCache.set(cacheKey, preview);
    return preview;
  }
  public async getTimeline(
    input?: unknown,
    zeroBasedLine?: number,
    cancellation?: Pick<vscode.CancellationToken, 'isCancellationRequested'>
  ): Promise<HistoryTimelineModel | undefined> {
    const cancelled = (): boolean => cancellation?.isCancellationRequested === true;
    if (cancelled()) return undefined;
    const target = this.resolveTarget(input);
    if (target === undefined || cancelled()) return undefined;
    const repository = historyRepository(target.entry);
    const working = await currentChangeItem(repository, target.root, target.path);
    if (cancelled()) return undefined;
    const historyPath = working?.headPath ?? target.path;
    let commitLine: number | undefined;
    let history: readonly (CommitSummary | FileHistoryEntry)[];

    if (zeroBasedLine === undefined) {
      history = repository.getFileHistoryEntries === undefined
        ? await repository.getFileHistory(historyPath)
        : await repository.getFileHistoryEntries(historyPath);
    } else {
      if (!Number.isSafeInteger(zeroBasedLine) || zeroBasedLine < 0) return undefined;
      const headLine = working !== undefined && repository.mapWorkingLineToHead !== undefined
        ? await repository.mapWorkingLineToHead(working.workingPath, zeroBasedLine + 1)
        : zeroBasedLine + 1;
      if (cancelled()) return undefined;
      commitLine = (headLine ?? zeroBasedLine + 1) - 1;
      history = working?.headExists === false || headLine === undefined
        ? []
        : await repository.getLineHistory(historyPath, headLine);
    }
    if (cancelled()) return undefined;

    const commits = commitQuickPickItems(history, target.identity, historyPath, this.now())
      .map((item, index): CommitTimelineEntry => ({
        id: `commit:${item.commit.hash}:${encodeURIComponent(item.path)}`,
        kind: 'commit',
        title: item.commit.subject,
        relativeDate: relativeDate(item.commit.authoredAt, this.now()),
        authoredAt: item.commit.authoredAt,
        latest: index === 0,
        commit: item.commit,
        path: item.path,
        parentPath: item.parentPath
      }));
    const workingEntry: WorkingTimelineEntry[] = working === undefined ? [] : [{
      id: 'working',
      kind: 'working',
      title: 'Current changes',
      detail: working.detail ?? working.workingPath,
      headPath: working.headPath,
      workingPath: working.workingPath,
      exists: working.exists,
      headExists: working.headExists
    }];
    const sourceRecord = target.entry.analyzer.getSnapshot().files
      .find(({ relativePath }) => relativePath === target.path);
    return {
      root: target.root,
      head: target.head,
      sourcePath: join(target.root, target.path),
      sourceExists: sourceRecord?.exists ?? true,
      relativePath: target.path,
      mode: zeroBasedLine === undefined ? 'file' : 'line',
      ...(zeroBasedLine === undefined ? {} : { line: zeroBasedLine, commitLine }),
      entries: [...workingEntry, ...commits]
    };
  }

  public async openTimelineEntry(model: HistoryTimelineModel, id: string): Promise<void> {
    const entry = model.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return;
    if (model.sourceExists) {
      await vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.file(model.sourcePath),
        { preview: false, preserveFocus: true, viewColumn: vscode.ViewColumn.One }
      );
    }

    const line = entry.kind === 'working' ? model.line : model.commitLine;
    const suffix = line === undefined ? '' : `:${line + 1}`;
    const separator = String.fromCharCode(0xb7);
    if (entry.kind === 'working') {
      const before = revisionUri(model.root, model.head, entry.headPath);
      const after = entry.exists
        ? vscode.Uri.file(join(model.root, entry.workingPath))
        : revisionUri(model.root, EMPTY_REVISION, entry.workingPath);
      await vscode.commands.executeCommand(
        'vscode.diff',
        before,
        after,
        `${basename(entry.workingPath)}${suffix} ${separator} Working changes`,
        { preview: true, preserveFocus: false, viewColumn: vscode.ViewColumn.Beside }
      );
      if (line !== undefined) revealLine(line, before, after);
      return;
    }

    const beforePath = entry.parentPath ?? entry.path;
    const before = revisionUri(model.root, `${entry.commit.hash}^`, beforePath);
    const after = revisionUri(model.root, entry.commit.hash, entry.path);
    await vscode.commands.executeCommand(
      'vscode.diff',
      before,
      after,
      `${basename(entry.path)}${suffix} ${separator} ${entry.commit.hash.slice(0, 7)}`,
      { preview: true, preserveFocus: false, viewColumn: vscode.ViewColumn.Beside }
    );
    if (line !== undefined) revealLine(line, before, after);
  }

  public async showFileHistory(input?: unknown): Promise<void> {
    const target = this.resolveTarget(input);
    if (target === undefined) return;
    const repository = historyRepository(target.entry);
    const working = await currentChangeItem(repository, target.root, target.path);
    const historyPath = working?.headPath ?? target.path;
    const history = repository.getFileHistoryEntries === undefined
      ? await repository.getFileHistory(historyPath)
      : await repository.getFileHistoryEntries(historyPath);
    const items: HistoryQuickPickItem[] = [
      ...(working === undefined ? [] : [working]),
      ...commitQuickPickItems(history, target.identity, target.path, this.now())
    ];
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `What Did I Write? history for ${target.path}`,
      onDidSelectItem: (item) => this.openHistoryItem(target, item as HistoryQuickPickItem, 'preview')
    });
    if (selected === undefined) return;
    await this.openHistoryItem(target, selected, 'pinned');
  }

  public async showLineHistory(input?: unknown, zeroBasedLine?: number): Promise<void> {
    const target = this.resolveTarget(input);
    if (target === undefined) return;
    const activeLine = zeroBasedLine ?? vscode.window.activeTextEditor?.selection.active.line;
    if (!Number.isSafeInteger(activeLine) || (activeLine as number) < 0) return;
    const line = activeLine as number;
    const repository = historyRepository(target.entry);
    const working = await currentChangeItem(repository, target.root, target.path);
    const historyPath = working?.headPath ?? target.path;
    const headLine = working !== undefined && repository.mapWorkingLineToHead !== undefined
      ? await repository.mapWorkingLineToHead(working.workingPath, line + 1)
      : line + 1;
    const history = working?.headExists === false || headLine === undefined
      ? []
      : await repository.getLineHistory(historyPath, headLine);
    const items: HistoryQuickPickItem[] = [
      ...(working === undefined ? [] : [working]),
      ...commitQuickPickItems(history, target.identity, target.path, this.now())
    ];
    const commitLine = (headLine ?? line + 1) - 1;
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `What Did I Write? line history for ${target.path}:${line + 1}`,
      onDidSelectItem: (item) => this.openHistoryItem(target, item as HistoryQuickPickItem, 'preview', line, commitLine)
    });
    if (selected === undefined) return;
    await this.openHistoryItem(target, selected, 'pinned', line, commitLine);
  }

  public async openCommitDiff(target: CommitDiffTarget | HistoryTreeNode, mode: HistoryOpenMode = 'pinned'): Promise<void> {
    const detailed = await this.resolveCommitTarget(target);
    const path = detailed.path ?? detailed.relativePath;
    const parentPath = Object.prototype.hasOwnProperty.call(detailed, 'parentPath')
      ? detailed.parentPath
      : path;
    const beforePath = parentPath ?? path;
    const before = revisionUri(detailed.root, `${detailed.commit.hash}^`, beforePath);
    const after = revisionUri(detailed.root, detailed.commit.hash, path);
    const displayPath = parentPath !== undefined && parentPath !== path
      ? `${parentPath} → ${path}`
      : path;
    const location = detailed.line === undefined ? displayPath : `${displayPath}:${detailed.line + 1}`;
    const title = `${location} — ${detailed.commit.subject} (${detailed.commit.hash.slice(0, 7)})`;
    await vscode.commands.executeCommand('vscode.diff', before, after, title, diffOptions(mode));
    if (detailed.line !== undefined) revealLine(detailed.line, before, after);
  }

  public async openWorkingTreeDiff(target: {
    readonly root: string;
    readonly head: string;
    readonly headPath: string;
    readonly workingPath: string;
    readonly exists: boolean;
    readonly line?: number;
  }, mode: HistoryOpenMode = 'pinned'): Promise<void> {
    const before = revisionUri(target.root, target.head, target.headPath);
    const after = target.exists
      ? vscode.Uri.file(join(target.root, target.workingPath))
      : revisionUri(target.root, EMPTY_REVISION, target.workingPath);
    const displayPath = target.headPath === target.workingPath
      ? target.workingPath
      : `${target.headPath} → ${target.workingPath}`;
    const location = target.line === undefined ? displayPath : `${displayPath}:${target.line + 1}`;
    await vscode.commands.executeCommand(
      'vscode.diff', before, after, `${location} — Current changes`, diffOptions(mode)
    );
    if (target.line !== undefined) revealLine(target.line, before, after);
  }

  private async openHistoryItem(
    target: ResolvedTarget,
    selected: HistoryQuickPickItem,
    mode: HistoryOpenMode,
    workingLine?: number,
    commitLine?: number
  ): Promise<void> {
    if (selected.itemType === 'working') {
      await this.openWorkingTreeDiff({ ...target, ...selected, line: workingLine }, mode);
      return;
    }
    await this.openCommitDiff({
      root: target.root,
      relativePath: target.path,
      commit: selected.commit,
      path: selected.path,
      parentPath: selected.parentPath,
      line: commitLine
    }, mode);
  }

  private resolveTarget(input: unknown): ResolvedTarget | undefined {
    if (isFileNode(input)) {
      const entry = this.registry.repositories.find(({ root }) => sameRoot(root, input.root));
      return entry === undefined ? undefined : targetFor(entry, join(input.root, input.file.relativePath));
    }
    const source = sourcePath(input);
    if (source !== undefined) {
      const uri = vscode.Uri.file(source);
      const entry = this.registry.findByUri(uri);
      return entry === undefined ? undefined : targetFor(entry, uri.fsPath);
    }
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || editor.document.uri.scheme !== 'file') return undefined;
    const entry = this.registry.findByUri(editor.document.uri);
    return entry === undefined ? undefined : targetFor(entry, editor.document.uri.fsPath);
  }

  private async resolveCommitTarget(target: CommitDiffTarget | HistoryTreeNode): Promise<CommitDiffTarget> {
    if (Object.prototype.hasOwnProperty.call(target, 'path')) return target;
    const entry = this.registry.repositories.find(({ root }) => sameRoot(root, target.root));
    if (entry === undefined) return target;
    const repository = historyRepository(entry);
    if (repository.getFileHistoryEntries === undefined) return target;
    const history = await repository.getFileHistoryEntries(target.relativePath);
    const match = history.find(({ commit }) => commit.hash === target.commit.hash);
    return match === undefined ? target : { ...target, path: match.path, parentPath: match.parentPath };
  }
}

interface ResolvedTarget {
  readonly root: string;
  readonly path: string;
  readonly head: string;
  readonly identity: GitIdentity;
  readonly entry: RegisteredRepository;
}

function targetFor(entry: RegisteredRepository, absolutePath: string): ResolvedTarget | undefined {
  if (entry.state !== 'ready') return undefined;
  const path = relative(entry.root, absolutePath);
  if (path === '' || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return undefined;
  const snapshot = entry.analyzer.getSnapshot();
  if (!/^[0-9a-f]{7,64}$/i.test(snapshot.head)) return undefined;
  return {
    root: entry.root,
    path: sep === '/' ? path : path.split(sep).join('/'),
    head: snapshot.head,
    identity: snapshot.identity,
    entry
  };
}

function historyRepository(entry: RegisteredRepository): HistoryRepository {
  return entry.repository as unknown as HistoryRepository;
}

async function currentChangeItem(
  repository: HistoryRepository,
  root: string,
  path: string
): Promise<WorkingHistoryQuickPickItem | undefined> {
  const changes = await repository.getWorkingChanges();
  const matching = changes.filter(
    ({ path: changedPath, originalPath }) => changedPath === path || originalPath === path
  );
  if (matching.length === 0) return undefined;
  const rename = matching.find(({ originalPath }) => originalPath !== undefined);
  const headPath = rename?.originalPath ?? path;
  const workingPath = rename?.path ?? path;
  const onlyNew = matching.every(
    ({ status }) => !status.includes('D') && (status === '?' || status.includes('A'))
  );
  const fallbackExists = matching.some(
    ({ status }) => status === '?' || !status.includes('D')
  );
  const exists = await workspacePathExists(join(root, workingPath), fallbackExists);
  return {
    itemType: 'working',
    label: 'Current changes',
    description: matching.map(({ status }) => status).join(', '),
    detail: rename?.originalPath === undefined
      ? workingPath
      : `${rename.originalPath} → ${workingPath}`,
    headPath,
    workingPath,
    exists,
    headExists: rename !== undefined || !onlyNew
  };
}

function userCommits(history: readonly CommitSummary[], identity: GitIdentity): CommitSummary[] {
  return history.filter((commit) => matchesIdentity(identity, commit.authorName, commit.authorEmail))
    .sort((left, right) => right.authoredAt - left.authoredAt);
}

function relativeDate(authoredAt: number, now: number): string {
  const elapsedSeconds = Math.round((authoredAt * 1_000 - now) / 1_000);
  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000], ['month', 2_592_000], ['week', 604_800],
    ['day', 86_400], ['hour', 3_600], ['minute', 60]
  ];
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
  for (const [unit, seconds] of units) {
    if (Math.abs(elapsedSeconds) >= seconds) return formatter.format(Math.round(elapsedSeconds / seconds), unit);
  }
  return formatter.format(elapsedSeconds, 'second');
}

function sourcePath(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return undefined;
  const uri = input as Partial<vscode.Uri>;
  return uri.scheme === 'file' && typeof uri.fsPath === 'string' ? uri.fsPath : undefined;
}

function isFileNode(input: unknown): input is {
  readonly kind: 'file'; readonly root: string; readonly file: { readonly relativePath: string };
} {
  if (typeof input !== 'object' || input === null) return false;
  const value = input as { readonly kind?: unknown; readonly root?: unknown; readonly file?: { readonly relativePath?: unknown } };
  return value.kind === 'file'
    && typeof value.root === 'string'
    && typeof value.file?.relativePath === 'string';
}

function isHistoryEntry(value: CommitSummary | FileHistoryEntry): value is FileHistoryEntry {
  return 'commit' in value;
}

function diffOptions(mode: HistoryOpenMode): vscode.TextDocumentShowOptions {
  return mode === 'preview'
    ? { preview: true, preserveFocus: true }
    : { preview: false };
}

function revealLine(line: number, before: vscode.Uri, after: vscode.Uri): void {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.lineCount < 1) return;
  const activeUri = editor.document.uri.toString();
  if (activeUri !== before.toString() && activeUri !== after.toString()) {
    return;
  }
  const safeLine = Math.min(Math.max(line, 0), editor.document.lineCount - 1);
  const position = new vscode.Position(safeLine, 0);
  const selection = new vscode.Selection(position, position);
  editor.selection = selection;
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function workspacePathExists(path: string, fallback: boolean): Promise<boolean> {
  const workspaceFs = (vscode.workspace as unknown as {
    readonly fs?: { stat(uri: vscode.Uri): Thenable<unknown> };
  }).fs;
  if (workspaceFs === undefined) {
    return fallback;
  }
  try {
    await workspaceFs.stat(vscode.Uri.file(path));
    return true;
  } catch {
    return false;
  }
}
function sameRoot(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
}
