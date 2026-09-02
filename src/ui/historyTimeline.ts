import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import * as vscode from 'vscode';

import type { LineChangeStats } from '../core/model.js';
import { displayLanguage, formatDateTime, localize } from '../localization.js';

import type { CommitTimelineEntry, HistoryController, HistoryTimelineModel, WorkingTimelineEntry } from './historyController.js';

export type HistoryTimelineViewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty'; readonly path: string }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly model: HistoryTimelineModel;
      readonly baseId?: string;
      readonly summaryStats?: LineChangeStats;
      readonly commitStats?: ReadonlyMap<string, LineChangeStats>;
      readonly refreshing?: boolean;
    };

type TimelineHistoryAccess = Pick<HistoryController, 'getTimeline' | 'openTimelineEntry'> & {
  getSelectionTimeline?: HistoryController['getSelectionTimeline'];
  getTimelineCommitStats?: HistoryController['getTimelineCommitStats'];
  getTimelineComparisonStats?: HistoryController['getTimelineComparisonStats'];
  openTimelineComparison?: HistoryController['openTimelineComparison'];
};

export interface HistoryTimelineRefreshScheduler {
  schedule(callback: () => void): vscode.Disposable;
}

const microtaskRefreshScheduler: HistoryTimelineRefreshScheduler = {
  schedule(callback) {
    let active = true;
    queueMicrotask(() => {
      if (active) callback();
    });
    return {
      dispose: () => {
        active = false;
      }
    };
  }
};

export class HistoryTimelineViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly viewSubscriptions: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private target: unknown;
  private selection: readonly unknown[] | undefined;
  private line: number | undefined;
  private model: HistoryTimelineModel | undefined;
  private baseId: string | undefined;
  private summaryStats: LineChangeStats | undefined;
  private commitStats: ReadonlyMap<string, LineChangeStats> | undefined;
  private summaryOperation = 0;
  private generation = 0;
  private registryRefreshDirty = false;
  private registryRefreshInFlight = false;
  private scheduledRegistryRefresh: vscode.Disposable | undefined;
  private disposed = false;

  public constructor(
    private readonly history: TimelineHistoryAccess,
    private readonly onError?: (error: unknown, operation: string, path: string) => void,
    private readonly refreshScheduler: HistoryTimelineRefreshScheduler = microtaskRefreshScheduler
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    if (this.disposed) return;
    this.detachView();
    this.view = view;
    view.webview.options = { enableScripts: true };
    const messageSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      void this.acceptMessage(message);
    });
    const disposeSubscription = view.onDidDispose(() => {
      this.detachView(view);
    });
    const visibilitySubscription = view.onDidChangeVisibility(() => {
      if (view.visible) this.scheduleVisibleRegistryRefresh();
      else this.cancelScheduledRegistryRefresh();
    });
    this.viewSubscriptions.push(messageSubscription, disposeSubscription, visibilitySubscription);
    this.render(this.model === undefined
      ? { kind: 'idle' }
      : { kind: 'ready', model: this.model, baseId: this.baseId, summaryStats: this.summaryStats, commitStats: this.commitStats });
    this.scheduleVisibleRegistryRefresh();
  }

  public async focus(input: unknown, line?: number): Promise<void> {
    if (this.disposed) return;
    if (input !== undefined) this.target = input;
    this.selection = undefined;
    this.model = undefined;
    this.baseId = undefined;
    this.summaryStats = undefined;
    this.commitStats = undefined;
    this.summaryOperation += 1;
    this.line = line;
    await this.refresh();
  }

  public async focusSelection(selection: readonly unknown[]): Promise<void> {
    if (this.disposed) return;
    if (selection.length === 0) {
      this.clear();
      return;
    }
    this.target = undefined;
    this.selection = [...selection];
    this.line = undefined;
    this.model = undefined;
    this.baseId = undefined;
    this.summaryStats = undefined;
    this.commitStats = undefined;
    this.summaryOperation += 1;
    await this.refresh();
  }

  public clear(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.target = undefined;
    this.selection = undefined;
    this.line = undefined;
    this.model = undefined;
    this.baseId = undefined;
    this.summaryStats = undefined;
    this.commitStats = undefined;
    this.summaryOperation += 1;
    this.registryRefreshDirty = false;
    this.cancelScheduledRegistryRefresh();
    this.updateDescription();
    this.render({ kind: 'idle' });
  }

  public followEditor(editor: vscode.TextEditor | undefined): void {
    if (this.disposed || editor?.document.uri.scheme !== 'file') return;
    if (this.model !== undefined && sameFilePath(this.model.sourcePath, editor.document.uri.fsPath)) {
      return;
    }
    this.target = editor.document.uri.fsPath;
    this.selection = undefined;
    this.line = undefined;
    this.model = undefined;
    this.baseId = undefined;
    this.summaryStats = undefined;
    this.commitStats = undefined;
    this.summaryOperation += 1;
    this.scheduleRegistryRefresh();
  }

  public async refresh(): Promise<void> {
    this.registryRefreshDirty = false;
    this.cancelScheduledRegistryRefresh();
    await this.refreshNow();
  }

  public scheduleRegistryRefresh(suppressed = false): void {
    if (this.disposed || suppressed) return;
    this.registryRefreshDirty = true;
    this.scheduleVisibleRegistryRefresh();
  }

  private async refreshNow(): Promise<void> {
    if (this.disposed || !this.hasTarget()) return;
    const generation = this.generation + 1;
    this.generation = generation;
    const target = this.target;
    const selection = this.selection;
    const line = this.line;
    const cancellation = {
      get isCancellationRequested(): boolean {
        return !provider.isCurrent(generation);
      }
    };
    const provider = this;
    try {
      if (this.model === undefined) {
        this.render({ kind: 'loading' });
      } else {
        this.render({ kind: 'ready', model: this.model, baseId: this.baseId, summaryStats: this.summaryStats, commitStats: this.commitStats, refreshing: true });
      }
      const model = selection === undefined
        ? await this.history.getTimeline(target, line, cancellation)
        : await this.history.getSelectionTimeline?.(selection, cancellation);
      if (!this.isCurrent(generation)) return;
      this.model = model;
      this.commitStats = undefined;
      if (this.baseId !== undefined && !model?.entries.some(({ id }) => id === this.baseId)) {
        this.baseId = undefined;
        this.summaryStats = undefined;
      }
      if (model === undefined) {
        this.render({ kind: 'empty', path: selection === undefined ? targetLabel(target) : localize('selection') });
      } else if (model.entries.length === 0) {
        this.render({ kind: 'empty', path: model.relativePath });
      } else {
        this.render({ kind: 'ready', model, baseId: this.baseId, summaryStats: this.summaryStats });
        void this.updateCommitStats(model, generation);
      }
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      const path = selection === undefined ? targetLabel(target) : localize('selection');
      this.onError?.(error, 'history-timeline', path);
      this.render({ kind: 'error', message: errorMessage(error) });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.summaryOperation += 1;
    this.registryRefreshDirty = false;
    this.cancelScheduledRegistryRefresh();
    this.detachView();
    this.model = undefined;
  }

  private async acceptMessage(message: unknown): Promise<void> {
    const model = this.model;
    if (model === undefined) return;
    if (isBaseMessage(message)) {
      const entry = model.entries.find(({ id }) => id === message.id);
      if (model.mode === 'line' || entry === undefined || entry.kind === 'working') return;
      this.baseId = this.baseId === entry.id ? undefined : entry.id;
      this.summaryStats = undefined;
      const operation = ++this.summaryOperation;
      const baseId = this.baseId;
      await this.view?.webview.postMessage(baseId === undefined
        ? { type: 'setBase' }
        : { type: 'setBase', id: baseId });
      if (operation !== this.summaryOperation || this.model !== model || this.baseId !== baseId) return;
      if (baseId === undefined) {
        await this.postSummary(comparisonGuidance());
      } else {
        await this.updateComparisonSummary(model, baseId, undefined, operation);
      }
      return;
    }
    if (!isSelectionMessage(message)) return;
    if (!model.entries.some(({ id }) => id === message.id)) return;
    let comparisonOperation: number | undefined;
    try {
      if (model.mode !== 'line') {
        if (this.baseId === undefined || this.baseId === message.id) return;
        const operation = ++this.summaryOperation;
        comparisonOperation = operation;
        const provider = this;
        await this.history.openTimelineComparison?.(model, this.baseId, message.id, {
          get isCancellationRequested(): boolean {
            return operation !== provider.summaryOperation || provider.model !== model;
          }
        });
        if (operation !== this.summaryOperation || this.model !== model) return;
        await this.updateComparisonSummary(model, this.baseId, message.id, operation);
      } else {
        await this.history.openTimelineEntry(model, message.id);
      }
    } catch (error) {
      if (this.model !== model) return;
      if (comparisonOperation !== undefined && comparisonOperation !== this.summaryOperation) return;
      this.onError?.(error, 'open-history-diff', model.relativePath);
      this.render({ kind: 'error', message: errorMessage(error) });
    }
  }

  private detachView(expected?: vscode.WebviewView): void {
    if (expected !== undefined && this.view !== expected) return;
    this.view = undefined;
    this.cancelScheduledRegistryRefresh();
    for (const subscription of this.viewSubscriptions.splice(0)) subscription.dispose();
  }

  private scheduleVisibleRegistryRefresh(): void {
    if (
      this.disposed
      || !this.registryRefreshDirty
      || this.registryRefreshInFlight
      || this.scheduledRegistryRefresh !== undefined
      || !this.hasTarget()
      || this.view?.visible !== true
    ) return;
    let scheduled: vscode.Disposable;
    scheduled = this.refreshScheduler.schedule(() => {
      if (this.scheduledRegistryRefresh !== scheduled) return;
      this.scheduledRegistryRefresh = undefined;
      void this.runRegistryRefresh();
    });
    this.scheduledRegistryRefresh = scheduled;
  }

  private async runRegistryRefresh(): Promise<void> {
    if (
      this.disposed
      || !this.registryRefreshDirty
      || !this.hasTarget()
      || this.view?.visible !== true
    ) return;
    this.registryRefreshDirty = false;
    this.registryRefreshInFlight = true;
    try {
      await this.refreshNow();
    } finally {
      this.registryRefreshInFlight = false;
      this.scheduleVisibleRegistryRefresh();
    }
  }

  private cancelScheduledRegistryRefresh(): void {
    this.scheduledRegistryRefresh?.dispose();
    this.scheduledRegistryRefresh = undefined;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  private hasTarget(): boolean {
    return this.target !== undefined || this.selection !== undefined;
  }

  private async updateComparisonSummary(
    model: HistoryTimelineModel,
    baseId: string,
    targetId?: string,
    existingOperation?: number
  ): Promise<void> {
    if (this.history.getTimelineComparisonStats === undefined) return;
    const operation = existingOperation ?? ++this.summaryOperation;
    if (operation !== this.summaryOperation) return;
    await this.postSummary(localize('Calculating changes...'));
    let stats: LineChangeStats | undefined;
    try {
      stats = await this.history.getTimelineComparisonStats(model, baseId, targetId);
    } catch (error) {
      if (operation === this.summaryOperation && this.model === model && this.baseId === baseId) {
        this.onError?.(error, 'calculate-history-stats', model.relativePath);
        await this.postSummary(localize('Change totals unavailable'));
      }
      return;
    }
    if (operation !== this.summaryOperation || this.model !== model || this.baseId !== baseId) return;
    this.summaryStats = stats;
    await this.postSummary(stats === undefined ? comparisonGuidance() : stats);
  }

  private postSummary(value: string | LineChangeStats): Thenable<boolean> | undefined {
    return this.view?.webview.postMessage(typeof value === 'string'
      ? { type: 'setSummary', text: value }
      : { type: 'setSummary', stats: formattedStats(value) });
  }

  private async updateCommitStats(model: HistoryTimelineModel, generation: number): Promise<void> {
    if (this.history.getTimelineCommitStats === undefined) return;
    try {
      const stats = await this.history.getTimelineCommitStats(model);
      if (!this.isCurrent(generation) || this.model !== model) return;
      this.commitStats = stats;
      await this.view?.webview.postMessage({
        type: 'setCommitStats',
        items: [...stats].map(([id, value]) => ({ id, ...formattedStats(value) }))
      });
    } catch (error) {
      if (this.isCurrent(generation) && this.model === model) {
        this.onError?.(error, 'commit-history-stats', model.relativePath);
      }
    }
  }

  private updateDescription(): void {
    if (this.view === undefined) return;
    this.view.description = undefined;
  }

  private render(state: HistoryTimelineViewState): void {
    if (this.view === undefined) return;
    this.updateDescription();
    const nonce = randomBytes(16).toString('base64');
    this.view.webview.html = renderTimelineHtml(state, nonce, this.view.webview.cspSource);
  }
}

export function renderTimelineHtml(
  state: HistoryTimelineViewState,
  nonce: string,
  cspSource: string
): string {
  const policy = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource}`
  ].join('; ');
  const body = renderBody(state);
  const safeNonce = escapeHtml(nonce);
  const comparisonMode = state.kind === 'ready' && state.model.mode !== 'line';
  const baseClearHint = safeScriptString(localize('Right-click again to clear BASE'));
  return `<!doctype html>
<html lang="${escapeHtml(displayLanguage())}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${safeNonce}">
    :root { color-scheme: light dark; }
    body { color: var(--vscode-foreground); background: transparent; font-family: var(--vscode-font-family); font-size: 12px; margin: 0; padding: 8px 10px 18px; }
    .state { color: var(--vscode-descriptionForeground); line-height: 1.5; padding: 8px 2px; }
    .state strong { color: var(--vscode-foreground); display: block; margin-bottom: 4px; }
    .header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 9px; }
    .path { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mode { color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 700; letter-spacing: .08em; white-space: nowrap; }
    .working { margin-bottom: 10px; }
    .comparison-summary { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 18px; margin: 0 2px 10px; min-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .selection-files { color: var(--vscode-charts-blue); font-weight: 700; }
    .selection-lines { color: var(--vscode-charts-purple); font-weight: 700; }
    .stats-added { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .stats-modified { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .stats-deleted { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .refreshing { color: var(--vscode-descriptionForeground); font-size: 10px; margin: -5px 2px 8px; }
    .direction { align-items: center; color: var(--vscode-descriptionForeground); display: flex; font-size: 10px; font-weight: 700; justify-content: space-between; letter-spacing: .06em; margin: 0 4px 5px 22px; }
    .latest-label { color: var(--vscode-charts-green); }
    .timeline-rail { list-style: none; margin: 0; padding: 0; position: relative; }
    .timeline-rail::before { background: linear-gradient(var(--vscode-charts-green), var(--vscode-descriptionForeground), transparent); bottom: 4px; content: ''; left: 7px; opacity: .75; position: absolute; top: 3px; width: 2px; }
    .entry { margin: 0 0 7px; padding-left: 20px; position: relative; }
    .entry::before { background: var(--vscode-sideBar-background); border: 2px solid var(--vscode-descriptionForeground); border-radius: 50%; content: ''; height: 7px; left: 3px; position: absolute; top: 10px; width: 7px; z-index: 1; }
    .entry.latest::before { background: var(--vscode-charts-green); border-color: var(--vscode-charts-green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-charts-green) 18%, transparent); }
    .entry.base::before { background: var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
    .entry.base button.card { background: var(--vscode-list-activeSelectionBackground); border-color: var(--vscode-focusBorder); color: var(--vscode-list-activeSelectionForeground); }
    .entry:nth-child(2) { opacity: .9; }
    .entry:nth-child(n+3) { opacity: .76; }
    button.card { background: transparent; border: 1px solid transparent; border-radius: 5px; color: inherit; cursor: pointer; display: block; font: inherit; padding: 6px 7px; text-align: left; width: 100%; }
    button.card:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-widget-border); }
    button.card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .working button.card { background: var(--vscode-editor-inactiveSelectionBackground); }
    .badge { background: color-mix(in srgb, var(--vscode-charts-green) 18%, transparent); border-radius: 8px; color: var(--vscode-charts-green); display: inline-block; font-size: 9px; font-weight: 800; margin-left: 5px; padding: 1px 5px; }
    .base-badge { background: color-mix(in srgb, var(--vscode-focusBorder) 22%, transparent); color: var(--vscode-focusBorder); }
    .base-badge[hidden] { display: none; }
    .title { align-items: baseline; display: flex; font-weight: 600; gap: 6px; justify-content: space-between; line-height: 1.35; overflow-wrap: anywhere; }
    .subject { min-width: 0; overflow-wrap: anywhere; }
    .commit-stats { flex: none; font-size: 10px; font-weight: 600; white-space: nowrap; }
    .commit-stats[hidden], .summary-stats[hidden], .summary-text[hidden] { display: none; }
    .meta, .author { color: var(--vscode-descriptionForeground); display: block; font-size: 11px; line-height: 1.35; margin-top: 3px; overflow-wrap: anywhere; }
  </style>
</head>
<body>${body}
  <script nonce="${safeNonce}">
    const vscode = acquireVsCodeApi();
    const comparisonMode = ${comparisonMode ? 'true' : 'false'};
    const baseClearHint = ${baseClearHint};
    const applyBase = (id) => {
      document.querySelectorAll('[data-entry-id]').forEach((button) => {
        const entry = button.closest('.entry');
        if (!entry) return;
        const selected = button instanceof HTMLElement && button.dataset.entryId === id;
        entry.classList.toggle('base', selected);
        const badge = button.querySelector('[data-base-badge]');
        if (badge instanceof HTMLElement) badge.hidden = !selected;
        if (button instanceof HTMLElement) button.title = selected ? baseClearHint : '';
      });
    };
    const fillStats = (element, stats) => {
      if (!(element instanceof HTMLElement)) return;
      const added = element.querySelector('[data-added]');
      const modified = element.querySelector('[data-modified]');
      const deleted = element.querySelector('[data-deleted]');
      if (added) added.textContent = '+' + stats.added;
      if (modified) modified.textContent = '~' + stats.modified;
      if (deleted) deleted.textContent = '-' + stats.deleted;
      element.hidden = false;
    };
    const applySummaryText = (text) => {
      const label = document.querySelector('[data-summary-total]');
      const message = document.querySelector('[data-summary-text]');
      const stats = document.querySelector('[data-stats-id="summary"]');
      if (label instanceof HTMLElement) label.hidden = true;
      if (message instanceof HTMLElement) { message.textContent = text; message.hidden = false; }
      if (stats instanceof HTMLElement) stats.hidden = true;
    };
    const applySummaryStats = (value) => {
      const label = document.querySelector('[data-summary-total]');
      const message = document.querySelector('[data-summary-text]');
      const stats = document.querySelector('[data-stats-id="summary"]');
      if (label instanceof HTMLElement) label.hidden = false;
      if (message instanceof HTMLElement) message.hidden = true;
      fillStats(stats, value);
    };
    const applyCommitStats = (value) => {
      const stats = [...document.querySelectorAll('[data-stats-id]')]
        .find((element) => element instanceof HTMLElement && element.dataset.statsId === value.id);
      fillStats(stats, value);
    };
    document.addEventListener('contextmenu', (event) => {
      if (!comparisonMode) return;
      const target = event.target instanceof Element ? event.target.closest('[data-entry-id]') : null;
      if (!(target instanceof HTMLElement) || !target.dataset.entryId || target.dataset.entryKind === 'working') return;
      event.preventDefault();
      applyBase(target.dataset.entryId);
      vscode.postMessage({ type: 'setBase', id: target.dataset.entryId });
    });
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-entry-id]') : null;
      if (target instanceof HTMLElement && target.dataset.entryId) {
        vscode.postMessage({ type: 'select', id: target.dataset.entryId });
      }
    });
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'setBase') {
        applyBase(typeof event.data.id === 'string' ? event.data.id : undefined);
      }
      if (event.data && event.data.type === 'setSummary' && typeof event.data.text === 'string') {
        applySummaryText(event.data.text);
      }
      if (event.data && event.data.type === 'setSummary' && event.data.stats) {
        applySummaryStats(event.data.stats);
      }
      if (event.data && event.data.type === 'setCommitStats' && Array.isArray(event.data.items)) {
        event.data.items.forEach((item) => applyCommitStats(item));
      }
    });
  </script>
</body>
</html>`;
}

function renderBody(state: HistoryTimelineViewState): string {
  switch (state.kind) {
    case 'idle':
      return stateMessage('File history', localize('Open a file or run Show File History.'));
    case 'loading':
      return stateMessage('Loading history...', localize('Reading local Git history.'));
    case 'empty':
      return stateMessage('No matching commits', localize('{path} has no commits by your Git identity.', { path: state.path }));
    case 'error':
      return stateMessage('History unavailable', state.message);
    case 'ready':
      return renderModel(state.model, state.baseId, state.summaryStats, state.commitStats, state.refreshing === true);
  }
}

function renderModel(
  model: HistoryTimelineModel,
  baseId?: string,
  summaryStats?: LineChangeStats,
  commitStats?: ReadonlyMap<string, LineChangeStats>,
  refreshing = false
): string {
  const working = model.entries.find((entry): entry is WorkingTimelineEntry => entry.kind === 'working');
  const commits = model.entries.filter((entry): entry is CommitTimelineEntry => entry.kind === 'commit');
  const original = model.entries.find((entry) => entry.kind === 'original');
  const mode = model.mode === 'line'
    ? localize('LINE {line}', { line: (model.line ?? 0) + 1 })
    : model.mode === 'selection' ? localize('SELECTION') : localize('FILE');
  const workingMarkup = working === undefined ? '' : `
    <div class="working">${entryButton(working.id, 'working', localize('Current changes'), working.detail)}</div>`;
  const commitMarkup = commits.map((entry) => {
    const stats = entry.stats ?? commitStats?.get(entry.id);
    return `
    <li class="entry${entry.latest ? ' latest' : ''}${entry.id === baseId ? ' base' : ''}">
      <button class="card" type="button" data-entry-id="${escapeHtml(entry.id)}" data-entry-kind="commit"${entry.id === baseId ? ` title="${escapeHtml(localize('Right-click again to clear BASE'))}"` : ''}>
        <span class="title"><span class="subject">${escapeHtml(entry.title)}${entry.latest ? `<span class="badge">${escapeHtml(localize('LATEST'))}</span>` : ''}<span class="badge base-badge" data-base-badge${entry.id === baseId ? '' : ' hidden'}>${escapeHtml(localize('BASE'))}</span></span>${statsMarkup('commit-stats', entry.id, stats)}</span>
        <span class="meta">${escapeHtml(entry.commit.hash.slice(0, 7))} | ${escapeHtml(entry.relativeDate)} | ${escapeHtml(formatDateTime(entry.authoredAt))}</span>
        <span class="author">${escapeHtml(entry.commit.authorName)} &lt;${escapeHtml(entry.commit.authorEmail)}&gt;</span>
      </button>
    </li>`;
  }).join('');
  const originalMarkup = original === undefined ? '' : `
    <li class="entry original${original.id === baseId ? ' base' : ''}">
      <button class="card" type="button" data-entry-id="${escapeHtml(original.id)}" data-entry-kind="original"${original.id === baseId ? ` title="${escapeHtml(localize('Right-click again to clear BASE'))}"` : ''}>
        <span class="title">${escapeHtml(original.title)}<span class="badge base-badge" data-base-badge${original.id === baseId ? '' : ' hidden'}>${escapeHtml(localize('BASE'))}</span></span>
        <span class="meta">${escapeHtml(original.detail)}</span>
      </button>
    </li>`;
  const comparisonSummary = model.mode !== 'line'
    ? `<div id="comparison-summary" class="comparison-summary">${selectionCountsMarkup(model)}${model.fileCount === undefined ? '' : ' · '}${summaryContentMarkup(
        baseId === undefined ? comparisonGuidance() : summaryStats === undefined ? localize('Calculating changes...') : summaryStats
      )}</div>`
    : '';
  const refreshingMarkup = refreshing
    ? `<div class="refreshing">${escapeHtml(localize('Refreshing history...'))}</div>`
    : '';
  return `
    <div class="header"><span class="path">${escapeHtml(model.relativePath)}</span><span class="mode">${mode}</span></div>
    ${refreshingMarkup}
    ${comparisonSummary}
    ${workingMarkup}
    <div class="direction"><span class="latest-label">${escapeHtml(localize('LATEST'))}</span><span>${escapeHtml(localize('Older'))} &darr;</span></div>
    <ol class="timeline-rail" aria-label="${escapeHtml(localize('Newest to oldest'))}">${commitMarkup}${originalMarkup}</ol>`;
}

function stateMessage(title: string, detail: string): string {
  return `<div class="state"><strong>${escapeHtml(localize(title))}</strong>${escapeHtml(detail)}</div>`;
}

function entryButton(id: string, kind: string, title: string, detail: string): string {
  return `<button class="card" type="button" data-entry-id="${escapeHtml(id)}" data-entry-kind="${escapeHtml(kind)}"><span class="title">${escapeHtml(title)}</span><span class="meta">${escapeHtml(detail)}</span></button>`;
}

function comparisonGuidance(): string {
  return localize('Right-click a commit to set BASE');
}

function formattedStats(stats: Pick<LineChangeStats, 'added' | 'modified' | 'deleted'>): {
  readonly added: string; readonly modified: string; readonly deleted: string;
} {
  return {
    added: formatNumber(stats.added),
    modified: formatNumber(stats.modified),
    deleted: formatNumber(stats.deleted)
  };
}

function statsMarkup(className: string, id: string, stats?: LineChangeStats): string {
  const values = stats === undefined ? undefined : formattedStats(stats);
  return `<span class="${className}" data-stats-id="${escapeHtml(id)}"${values === undefined ? ' hidden' : ''}><span class="stats-added" data-added>+${values?.added ?? ''}</span> <span class="stats-modified" data-modified>~${values?.modified ?? ''}</span> <span class="stats-deleted" data-deleted>-${values?.deleted ?? ''}</span></span>`;
}

function selectionCountsMarkup(model: HistoryTimelineModel): string {
  if (model.fileCount === undefined || model.currentOwnedLines === undefined) return '';
  return `<span class="selection-files">${escapeHtml(localize('{count} files', { count: formatNumber(model.fileCount) }))}</span> · <span class="selection-lines">${escapeHtml(localize('{lines}L', { lines: formatNumber(model.currentOwnedLines) }))}</span>`;
}

function summaryContentMarkup(value: string | LineChangeStats): string {
  const text = typeof value === 'string' ? value : '';
  const stats = typeof value === 'string' ? undefined : value;
  return `<span data-summary-total${stats === undefined ? ' hidden' : ''}>${escapeHtml(localize('TOTAL'))} </span><span class="summary-text" data-summary-text${stats === undefined ? '' : ' hidden'}>${escapeHtml(text)}</span>${statsMarkup('summary-stats', 'summary', stats)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(displayLanguage()).format(value);
}

function safeScriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSelectionMessage(value: unknown): value is { readonly type: 'select'; readonly id: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly type?: unknown; readonly id?: unknown };
  return candidate.type === 'select' && typeof candidate.id === 'string';
}

function isBaseMessage(value: unknown): value is { readonly type: 'setBase'; readonly id: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly type?: unknown; readonly id?: unknown };
  return candidate.type === 'setBase' && typeof candidate.id === 'string';
}

function sameFilePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function targetLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { readonly fsPath?: unknown; readonly file?: { readonly relativePath?: unknown } };
    if (typeof candidate.fsPath === 'string') return candidate.fsPath;
    if (typeof candidate.file?.relativePath === 'string') return candidate.file.relativePath;
  }
  return 'active file';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
