import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import type { CommitTimelineEntry, HistoryController, HistoryTimelineModel, WorkingTimelineEntry } from './historyController.js';

export type HistoryTimelineViewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty'; readonly path: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly model: HistoryTimelineModel };

type TimelineHistoryAccess = Pick<HistoryController, 'getTimeline' | 'openTimelineEntry'>;

export class HistoryTimelineViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private target: unknown;
  private line: number | undefined;
  private model: HistoryTimelineModel | undefined;
  private generation = 0;
  private disposed = false;

  public constructor(
    private readonly history: TimelineHistoryAccess,
    private readonly onError?: (error: unknown, operation: string, path: string) => void
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    if (this.disposed) return;
    this.view = view;
    view.webview.options = { enableScripts: true };
    this.subscriptions.push(view.webview.onDidReceiveMessage((message: unknown) => {
      void this.acceptMessage(message);
    }));
    this.render(this.model === undefined ? { kind: 'idle' } : { kind: 'ready', model: this.model });
  }

  public async focus(input: unknown, line?: number): Promise<void> {
    if (this.disposed) return;
    if (input !== undefined) this.target = input;
    this.model = undefined;
    this.line = line;
    await this.refresh();
  }

  public followEditor(editor: vscode.TextEditor | undefined): void {
    if (this.disposed || editor?.document.uri.scheme !== 'file') return;
    this.target = editor.document.uri.fsPath;
    this.line = undefined;
    this.model = undefined;
    void this.refresh();
  }

  public async refresh(): Promise<void> {
    if (this.disposed || this.target === undefined) return;
    const generation = this.generation + 1;
    this.generation = generation;
    if (this.model === undefined) this.render({ kind: 'loading' });
    try {
      const model = await this.history.getTimeline(this.target, this.line);
      if (!this.isCurrent(generation)) return;
      this.model = model;
      if (model === undefined) {
        this.render({ kind: 'empty', path: targetLabel(this.target) });
      } else if (model.entries.length === 0) {
        this.render({ kind: 'empty', path: model.relativePath });
      } else {
        this.render({ kind: 'ready', model });
      }
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      const path = targetLabel(this.target);
      this.onError?.(error, 'history-timeline', path);
      this.render({ kind: 'error', message: errorMessage(error) });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    this.view = undefined;
    this.model = undefined;
  }

  private async acceptMessage(message: unknown): Promise<void> {
    const model = this.model;
    if (!isSelectionMessage(message) || model === undefined) return;
    if (!model.entries.some(({ id }) => id === message.id)) return;
    try {
      await this.history.openTimelineEntry(model, message.id);
    } catch (error) {
      this.onError?.(error, 'open-history-diff', model.relativePath);
      if (this.model === model) {
        this.render({ kind: 'error', message: errorMessage(error) });
      }
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  private render(state: HistoryTimelineViewState): void {
    if (this.view === undefined) return;
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
  return `<!doctype html>
<html lang="en">
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
    .direction { align-items: center; color: var(--vscode-descriptionForeground); display: flex; font-size: 10px; font-weight: 700; justify-content: space-between; letter-spacing: .06em; margin: 0 4px 5px 22px; }
    .latest-label { color: var(--vscode-charts-green); }
    .timeline-rail { list-style: none; margin: 0; padding: 0; position: relative; }
    .timeline-rail::before { background: linear-gradient(var(--vscode-charts-green), var(--vscode-descriptionForeground), transparent); bottom: 4px; content: ''; left: 7px; opacity: .75; position: absolute; top: 3px; width: 2px; }
    .entry { margin: 0 0 7px; padding-left: 20px; position: relative; }
    .entry::before { background: var(--vscode-sideBar-background); border: 2px solid var(--vscode-descriptionForeground); border-radius: 50%; content: ''; height: 7px; left: 3px; position: absolute; top: 10px; width: 7px; z-index: 1; }
    .entry.latest::before { background: var(--vscode-charts-green); border-color: var(--vscode-charts-green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-charts-green) 18%, transparent); }
    .entry:nth-child(2) { opacity: .9; }
    .entry:nth-child(n+3) { opacity: .76; }
    button.card { background: transparent; border: 1px solid transparent; border-radius: 5px; color: inherit; cursor: pointer; display: block; font: inherit; padding: 6px 7px; text-align: left; width: 100%; }
    button.card:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-widget-border); }
    button.card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .working button.card { background: var(--vscode-editor-inactiveSelectionBackground); }
    .badge { background: color-mix(in srgb, var(--vscode-charts-green) 18%, transparent); border-radius: 8px; color: var(--vscode-charts-green); display: inline-block; font-size: 9px; font-weight: 800; margin-left: 5px; padding: 1px 5px; }
    .title { display: block; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
    .meta, .author { color: var(--vscode-descriptionForeground); display: block; font-size: 11px; line-height: 1.35; margin-top: 3px; overflow-wrap: anywhere; }
  </style>
</head>
<body>${body}
  <script nonce="${safeNonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-entry-id]') : null;
      if (target instanceof HTMLElement && target.dataset.entryId) {
        vscode.postMessage({ type: 'select', id: target.dataset.entryId });
      }
    });
  </script>
</body>
</html>`;
}

function renderBody(state: HistoryTimelineViewState): string {
  switch (state.kind) {
    case 'idle':
      return '<div class="state"><strong>File history</strong>Open a file or choose history from a gutter marker.</div>';
    case 'loading':
      return '<div class="state"><strong>Loading history...</strong>Reading local Git history.</div>';
    case 'empty':
      return `<div class="state"><strong>No matching commits</strong>${escapeHtml(state.path)} has no commits by your Git identity.</div>`;
    case 'error':
      return `<div class="state"><strong>History unavailable</strong>${escapeHtml(state.message)}</div>`;
    case 'ready':
      return renderModel(state.model);
  }
}

function renderModel(model: HistoryTimelineModel): string {
  const working = model.entries.find((entry): entry is WorkingTimelineEntry => entry.kind === 'working');
  const commits = model.entries.filter((entry): entry is CommitTimelineEntry => entry.kind === 'commit');
  const mode = model.mode === 'line' ? `LINE ${(model.line ?? 0) + 1}` : 'FILE';
  const workingMarkup = working === undefined ? '' : `
    <div class="working">${entryButton(working.id, working.title, working.detail)}</div>`;
  const commitMarkup = commits.map((entry) => `
    <li class="entry${entry.latest ? ' latest' : ''}">
      <button class="card" type="button" data-entry-id="${escapeHtml(entry.id)}">
        <span class="title">${escapeHtml(entry.title)}${entry.latest ? '<span class="badge">LATEST</span>' : ''}</span>
        <span class="meta">${escapeHtml(entry.commit.hash.slice(0, 7))} | ${escapeHtml(entry.relativeDate)} | ${escapeHtml(new Date(entry.authoredAt * 1_000).toLocaleString())}</span>
        <span class="author">${escapeHtml(entry.commit.authorName)} &lt;${escapeHtml(entry.commit.authorEmail)}&gt;</span>
      </button>
    </li>`).join('');
  return `
    <div class="header"><span class="path">${escapeHtml(model.relativePath)}</span><span class="mode">${mode}</span></div>
    ${workingMarkup}
    <div class="direction"><span class="latest-label">LATEST</span><span>Older &darr;</span></div>
    <ol class="timeline-rail" aria-label="Newest to oldest">${commitMarkup}</ol>`;
}

function entryButton(id: string, title: string, detail: string): string {
  return `<button class="card" type="button" data-entry-id="${escapeHtml(id)}"><span class="title">${escapeHtml(title)}</span><span class="meta">${escapeHtml(detail)}</span></button>`;
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
