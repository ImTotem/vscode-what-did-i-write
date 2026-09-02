import { basename, isAbsolute, join, relative, sep } from 'node:path';

import * as vscode from 'vscode';

import { matchesIdentity } from '../core/identity.js';
import type { CommitSummary, GitIdentity, LineChangeStats, OwnedRange } from '../core/model.js';
import type { RegisteredRepository, RepositoryRegistry } from '../extension/repositoryRegistry.js';
import type { WorkingChange } from '../git/parsers.js';
import type { FileHistoryEntry } from '../git/repository.js';
import { formatDateTime, formatRelativeDate, localize } from '../localization.js';
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
  getDiffStats?(
    baseRevision: string,
    targetRevision: string | undefined,
    paths: readonly string[]
  ): Promise<LineChangeStats>;
  getCommitDiffStats?(
    head: string,
    commitHashes: readonly string[],
    paths: readonly string[]
  ): Promise<ReadonlyMap<string, LineChangeStats>>;
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

export type TimelineMode = 'file' | 'line' | 'selection';

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
  readonly stats?: LineChangeStats;
}

export interface OriginalTimelineEntry {
  readonly id: string;
  readonly kind: 'original';
  readonly title: string;
  readonly detail: string;
  readonly revision: string;
  readonly path: string;
  readonly exists: boolean;
}

export type HistoryTimelineEntry = WorkingTimelineEntry | CommitTimelineEntry | OriginalTimelineEntry;

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
  readonly fileCount?: number;
  readonly currentOwnedLines?: number;
  readonly selectedPaths?: readonly string[];
  readonly currentPaths?: readonly string[];
  readonly untrackedOwnedLines?: number;
  readonly untrackedPaths?: readonly string[];
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
      description: `${formatRelativeDate(commit.authoredAt, now)} · ${commit.hash.slice(0, 7)}`,
      detail: `${commit.authorName} <${commit.authorEmail}> · ${formatDateTime(commit.authoredAt)} · ${path}`,
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

    let commits = commitQuickPickItems(history, target.identity, historyPath, this.now())
      .map((item, index): CommitTimelineEntry => ({
        id: `commit:${item.commit.hash}:${encodeURIComponent(item.path)}`,
        kind: 'commit',
        title: item.commit.subject,
        relativeDate: formatRelativeDate(item.commit.authoredAt, this.now()),
        authoredAt: item.commit.authoredAt,
        latest: index === 0,
        commit: item.commit,
        path: item.path,
        parentPath: item.parentPath
      }));
    const oldest = commits.at(-1);
    const originalEntry: OriginalTimelineEntry[] = zeroBasedLine !== undefined || oldest === undefined
      ? []
      : [{
          id: 'original:' + oldest.commit.hash + ':' + encodeURIComponent(oldest.parentPath ?? oldest.path),
          kind: 'original',
          title: localize('ORIGINAL'),
          detail: oldest.parentPath === undefined
            ? localize('File did not exist')
            : localize('Before your first change'),
          revision: oldest.commit.hash + '^',
          path: oldest.parentPath ?? oldest.path,
          exists: oldest.parentPath !== undefined
        }];
    const workingEntry: WorkingTimelineEntry[] = working === undefined ? [] : [{
      id: 'working',
      kind: 'working',
      title: localize('Current changes'),
      detail: working.detail ?? working.workingPath,
      headPath: working.headPath,
      workingPath: working.workingPath,
      exists: working.exists,
      headExists: working.headExists
    }];
    const sourceRecord = target.entry.analyzer.getSnapshot().files
      .find(({ relativePath }) => relativePath === target.path);
    const selectedPaths = [...new Set([
      target.path,
      ...commits.flatMap(({ path, parentPath }) => parentPath === undefined ? [path] : [path, parentPath]),
      ...(working === undefined ? [] : [working.headPath, working.workingPath])
    ])].sort();
    const currentOwnedLines = sourceRecord?.ranges.reduce(
      (total, range) => total + Math.max(0, range.endExclusive - range.start), 0
    ) ?? 0;
    return {
      root: target.root,
      head: target.head,
      sourcePath: join(target.root, target.path),
      sourceExists: sourceRecord?.exists ?? true,
      relativePath: target.path,
      mode: zeroBasedLine === undefined ? 'file' : 'line',
      ...(zeroBasedLine === undefined ? {} : { line: zeroBasedLine, commitLine }),
      entries: [...workingEntry, ...commits, ...originalEntry],
      ...(zeroBasedLine === undefined ? {
        fileCount: 1,
        currentOwnedLines,
        selectedPaths,
        currentPaths: sourceRecord?.exists === false ? [] : [target.path]
      } : {})
    };
  }

  public async getTimelineCommitStats(
    model: HistoryTimelineModel
  ): Promise<ReadonlyMap<string, LineChangeStats>> {
    const result = new Map<string, LineChangeStats>();
    const paths = model.selectedPaths;
    if (paths === undefined || paths.length === 0) return result;
    const commits = model.entries.filter((entry): entry is CommitTimelineEntry => entry.kind === 'commit');
    if (commits.length === 0) return result;
    const entry = this.registry.repositories.find(({ root }) => sameRoot(root, model.root));
    if (entry === undefined) return result;
    const repository = historyRepository(entry);
    if (repository.getCommitDiffStats === undefined) return result;
    const byHash = await repository.getCommitDiffStats(
      model.head,
      commits.map(({ commit }) => commit.hash),
      paths
    );
    for (const commit of commits) {
      const stats = byHash.get(commit.commit.hash);
      if (stats !== undefined) result.set(commit.id, stats);
    }
    return result;
  }

  public async getSelectionTimeline(
    inputs: readonly unknown[],
    cancellation?: Pick<vscode.CancellationToken, 'isCancellationRequested'>
  ): Promise<HistoryTimelineModel | undefined> {
    const cancelled = (): boolean => cancellation?.isCancellationRequested === true;
    const targets = [...new Map(inputs.flatMap((input) => {
      const target = this.resolveTarget(input);
      return target === undefined ? [] : [[`${target.root}\0${target.path}`, target] as const];
    })).values()];
    if (targets.length === 0 || cancelled()) return undefined;
    const root = targets[0]?.root;
    if (root === undefined || targets.some((target) => !sameRoot(target.root, root))) return undefined;
    const first = targets[0] as ResolvedTarget;
    if (targets.length === 1) {
      return this.getTimeline(join(root, targets[0]?.path as string), undefined, cancellation);
    }
    const selectedPaths = targets.map(({ path }) => path).sort();
    const selectedSet = new Set(selectedPaths);
    const snapshot = first.entry.analyzer.getSnapshot();
    const selectedRecords = snapshot.files.filter(({ relativePath }) => selectedSet.has(relativePath));
    const currentOwnedLines = selectedRecords.reduce((total, record) => total + record.ranges.reduce(
      (fileTotal, range) => fileTotal + Math.max(0, range.endExclusive - range.start), 0
    ), 0);
    const commitPaths = new Map<string, { readonly commit: CommitSummary; readonly path: string }>();
    const aliases = new Set(selectedPaths);
    for (const record of selectedRecords) {
      for (const alias of record.aliases ?? [record.relativePath]) aliases.add(alias);
      for (const commit of record.history) {
        if (!commitPaths.has(commit.hash)) {
          commitPaths.set(commit.hash, { commit, path: record.relativePath });
        }
      }
    }
    const selectedEntries = [...commitPaths.values()]
      .sort((left, right) => right.commit.authoredAt - left.commit.authoredAt);
    const allPaths = [...aliases].sort();
    const commits = selectedEntries.map(({ commit, path }, index) => ({
      id: `commit:${commit.hash}`,
      kind: 'commit' as const,
      title: commit.subject,
      relativeDate: formatRelativeDate(commit.authoredAt, this.now()),
      authoredAt: commit.authoredAt,
      latest: index === 0,
      commit,
      path
    }));
    const oldest = commits.at(-1);
    const original: OriginalTimelineEntry[] = oldest === undefined ? [] : [{
      id: `original:${oldest.commit.hash}`,
      kind: 'original',
      title: localize('ORIGINAL'),
      detail: localize('Before your first change'),
      revision: `${oldest.commit.hash}^`,
      path: selectedPaths[0] as string,
      exists: true
    }];
    const selectedWorking = selectedRecords.filter(({ working }) => working);
    const untrackedPaths = new Set(selectedRecords
      .filter(({ untracked }) => untracked === true)
      .map(({ relativePath }) => relativePath));
    const untrackedOwnedLines = selectedRecords
      .filter(({ relativePath }) => untrackedPaths.has(relativePath))
      .reduce((total, record) => total + record.ranges.reduce(
        (fileTotal, range) => fileTotal + Math.max(0, range.endExclusive - range.start), 0
      ), 0);
    const working: WorkingTimelineEntry[] = selectedWorking.length === 0 ? [] : [{
      id: 'working',
      kind: 'working',
      title: localize('Current changes'),
      detail: localize('{count} selected files', { count: selectedPaths.length }),
      headPath: selectedPaths[0] as string,
      workingPath: selectedPaths[0] as string,
      exists: true,
      headExists: true
    }];
    return {
      root,
      head: first.head,
      sourcePath: root,
      sourceExists: false,
      relativePath: localize('{count} selected files', { count: selectedPaths.length }),
      mode: 'selection',
      entries: [...working, ...commits, ...original],
      fileCount: selectedPaths.length,
      currentOwnedLines,
      selectedPaths: allPaths,
      currentPaths: selectedRecords.filter(({ exists }) => exists).map(({ relativePath }) => relativePath),
      untrackedOwnedLines,
      untrackedPaths: [...untrackedPaths].sort()
    };
  }

  public async openTimelineComparison(
    model: HistoryTimelineModel,
    baseId: string,
    targetId: string,
    cancellation?: Pick<vscode.CancellationToken, 'isCancellationRequested'>
  ): Promise<void> {
    const cancelled = (): boolean => cancellation?.isCancellationRequested === true;
    if (cancelled()) return;
    if (baseId === targetId) return;
    const base = model.entries.find(({ id }) => id === baseId);
    const target = model.entries.find(({ id }) => id === targetId);
    if (base === undefined || target === undefined) return;
    if (model.mode === 'selection') {
      await this.openSelectionComparison(model, base, target, cancellation);
      return;
    }
    const sourceUri = vscode.Uri.file(model.sourcePath);
    const activeEditor = vscode.window.activeTextEditor;
    const sourceEditor = activeEditor?.document.uri.toString() === sourceUri.toString()
      ? activeEditor
      : vscode.window.visibleTextEditors
        .find(({ document }) => document.uri.toString() === sourceUri.toString());
    const viewColumn = sourceEditor?.viewColumn ?? activeEditor?.viewColumn;
    const sameGroup = viewColumn === undefined ? {} : { viewColumn };
    if (model.sourceExists) {
      await vscode.commands.executeCommand(
        'vscode.open',
        sourceUri,
        { preview: false, preserveFocus: true, ...sameGroup }
      );
    }
    if (cancelled()) return;

    const before = timelineRevisionUri(model.root, base);
    const after = timelineRevisionUri(model.root, target);
    const targetPath = timelinePath(target);
    const separator = String.fromCharCode(0xb7);
    await vscode.commands.executeCommand(
      'vscode.diff',
      before,
      after,
      basename(targetPath) + ' ' + separator + ' ' + timelineLabel(base) + ' → ' + timelineLabel(target),
      { preview: true, preserveFocus: false, ...sameGroup }
    );
    const line = target.kind === 'working' ? model.line : model.commitLine;
    if (line !== undefined) revealLine(line, before, after);
  }

  public async getTimelineComparisonStats(
    model: HistoryTimelineModel,
    baseId: string,
    targetId?: string
  ): Promise<LineChangeStats | undefined> {
    const base = model.entries.find(({ id }) => id === baseId);
    const target = targetId === undefined
      ? undefined
      : model.entries.find(({ id }) => id === targetId);
    const baseRevision = base === undefined || base.kind === 'working'
      ? undefined
      : base.kind === 'commit' ? base.commit.hash : base.revision;
    const targetRevision = target === undefined || target.kind === 'working'
      ? undefined
      : target.kind === 'commit' ? target.commit.hash : target.revision;
    const paths = model.selectedPaths;
    if (baseRevision === undefined || paths === undefined) return undefined;
    const entry = this.registry.repositories.find(({ root }) => sameRoot(root, model.root));
    if (entry === undefined) return undefined;
    const repository = historyRepository(entry);
    if (repository.getDiffStats === undefined) return undefined;
    const stats = await repository.getDiffStats(baseRevision, targetRevision, paths);
    const untracked = targetRevision === undefined ? model.untrackedOwnedLines ?? 0 : 0;
    return untracked === 0 ? stats : {
      ...stats,
      added: stats.added + untracked,
      paths: [...new Set([...stats.paths, ...(model.untrackedPaths ?? [])])].sort()
    };
  }

  public async openTimelineEntry(model: HistoryTimelineModel, id: string): Promise<void> {
    const entry = model.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return;
    const sourceUri = vscode.Uri.file(model.sourcePath);
    const activeEditor = vscode.window.activeTextEditor;
    const sourceEditor = activeEditor?.document.uri.toString() === sourceUri.toString()
      ? activeEditor
      : vscode.window.visibleTextEditors
        .find(({ document }) => document.uri.toString() === sourceUri.toString());
    const viewColumn = sourceEditor?.viewColumn ?? activeEditor?.viewColumn;
    const sameGroup = viewColumn === undefined ? {} : { viewColumn };
    if (model.sourceExists) {
      await vscode.commands.executeCommand(
        'vscode.open',
        sourceUri,
        { preview: false, preserveFocus: true, ...sameGroup }
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
        `${basename(entry.workingPath)}${suffix} ${separator} ${localize('Working changes')}`,
        { preview: false, preserveFocus: false, ...sameGroup }
      );
      if (line !== undefined) revealLine(line, before, after);
      return;
    }
    if (entry.kind === 'original') return;

    const beforePath = entry.parentPath ?? entry.path;
    const before = revisionUri(model.root, `${entry.commit.hash}^`, beforePath);
    const after = revisionUri(model.root, entry.commit.hash, entry.path);
    await vscode.commands.executeCommand(
      'vscode.diff',
      before,
      after,
      `${basename(entry.path)}${suffix} ${separator} ${entry.commit.hash.slice(0, 7)}`,
      { preview: false, preserveFocus: false, ...sameGroup }
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
      placeHolder: localize('What Did I Write? history for {path}', { path: target.path }),
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
      placeHolder: localize('What Did I Write? line history for {path}:{line}', { path: target.path, line: line + 1 }),
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
      'vscode.diff', before, after, `${location} — ${localize('Current changes')}`, diffOptions(mode)
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

  private async openSelectionComparison(
    model: HistoryTimelineModel,
    base: HistoryTimelineEntry,
    target: HistoryTimelineEntry,
    cancellation?: Pick<vscode.CancellationToken, 'isCancellationRequested'>
  ): Promise<void> {
    const baseRevision = base.kind === 'commit' ? base.commit.hash
      : base.kind === 'original' ? base.revision : undefined;
    const targetRevision = target.kind === 'commit' ? target.commit.hash
      : target.kind === 'original' ? target.revision : undefined;
    if (baseRevision === undefined) return;
    const stats = await this.getTimelineComparisonStats(model, base.id, target.id);
    if (cancellation?.isCancellationRequested === true) return;
    const paths = stats?.paths.length ? stats.paths : model.selectedPaths ?? [];
    const currentPaths = new Set(model.currentPaths ?? []);
    const resources = paths.map((path) => [
      vscode.Uri.file(join(model.root, path)),
      revisionUri(model.root, baseRevision, path),
      target.kind === 'working'
        ? currentPaths.has(path)
          ? vscode.Uri.file(join(model.root, path))
          : revisionUri(model.root, EMPTY_REVISION, path)
        : revisionUri(model.root, targetRevision as string, path)
    ] as const);
    if (resources.length === 0) return;
    await vscode.commands.executeCommand(
      'vscode.changes',
      `${model.relativePath} · ${timelineLabel(base)} → ${timelineLabel(target)}`,
      resources
    );
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

function timelineRevisionUri(root: string, entry: HistoryTimelineEntry): vscode.Uri {
  if (entry.kind === 'working') {
    return entry.exists
      ? vscode.Uri.file(join(root, entry.workingPath))
      : revisionUri(root, EMPTY_REVISION, entry.workingPath);
  }
  return revisionUri(root, entry.kind === 'commit' ? entry.commit.hash : entry.revision, entry.path);
}

function timelinePath(entry: HistoryTimelineEntry): string {
  return entry.kind === 'working' ? entry.workingPath : entry.path;
}

function timelineLabel(entry: HistoryTimelineEntry): string {
  if (entry.kind === 'working') return localize('Working changes');
  if (entry.kind === 'original') return localize('ORIGINAL');
  return entry.commit.hash.slice(0, 7);
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
    label: localize('Current changes'),
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
