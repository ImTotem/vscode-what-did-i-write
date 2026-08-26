import { isAbsolute, join, relative, sep } from 'node:path';

import * as vscode from 'vscode';

import { hasConfiguredIdentity } from '../core/identity.js';
import type { FileRecord, OwnedRange } from '../core/model.js';
import type { AnalyzerAccess, RepositoryRegistry } from '../extension/repositoryRegistry.js';

import type { HistoryPreview } from './historyController.js';
const FILE_HISTORY_COMMAND = 'myCode.focusFileHistory';
const LINE_HISTORY_COMMAND = 'myCode.focusLineHistory';
const TRUSTED_HOVER_COMMANDS = [FILE_HISTORY_COMMAND, LINE_HISTORY_COMMAND] as const;

export type CommandFactory = (command: string, args: readonly unknown[]) => string;

export function commandUri(command: string, args: readonly unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

export function toDecorationOptions(
  record: Pick<FileRecord, 'ranges'>,
  document: Pick<vscode.TextDocument, 'lineCount'>,
  sourcePath?: string
): vscode.DecorationOptions[] {
  return record.ranges.flatMap((ownedRange) => {
    const ownedDocumentRange = documentRange(ownedRange, document.lineCount);
    if (ownedDocumentRange === undefined) return [];
    const options: vscode.DecorationOptions[] = [];
    for (let line = ownedDocumentRange.start.line; line <= ownedDocumentRange.end.line; line += 1) {
      const range = new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, 0)
      );
      options.push({
        range,
        ...(sourcePath === undefined ? {} : {
          hoverMessage: ownershipHoverMarkdown(ownedRange, sourcePath, line)
        })
      });
    }
    return options;
  });
}

export function documentRange(range: Pick<OwnedRange, 'start' | 'endExclusive'>, lineCount: number): vscode.Range | undefined {
  const safeLineCount = Math.max(0, lineCount);
  const start = Math.min(Math.max(0, range.start), safeLineCount);
  const end = Math.min(Math.max(start, range.endExclusive), safeLineCount);
  if (start === end) return undefined;
  return new vscode.Range(
    new vscode.Position(start, 0),
    new vscode.Position(end - 1, Number.MAX_SAFE_INTEGER)
  );
}

export function ownershipHoverMarkdown(
  range: OwnedRange,
  sourcePath: string,
  zeroBasedLine: number,
  commandFactory: CommandFactory = commandUri
): vscode.MarkdownString {
  return compactOwnershipHover(new vscode.MarkdownString(), range, sourcePath, zeroBasedLine, commandFactory);
}

function compactOwnershipHover(
  hover: vscode.MarkdownString,
  range: OwnedRange,
  sourcePath: string,
  zeroBasedLine: number,
  commandFactory: CommandFactory
): vscode.MarkdownString {
  hover.appendMarkdown('**\uB0B4\uAC00 \uC791\uC131\uD55C \uCF54\uB4DC | Your code**');
  if (range.commit === undefined) {
    hover.appendMarkdown('\n\n_\uC544\uC9C1 \uCEE4\uBC0B\uB418\uC9C0 \uC54A\uC740 \uBCC0\uACBD_');
  } else {
    const commit = range.commit;
    const date = new Date(commit.authoredAt * 1_000).toLocaleDateString();
    hover.appendMarkdown(
      '\n\n\x60' + escapeMarkdown(commit.hash.slice(0, 7)) + '\x60 | '
        + escapeMarkdown(date) + '  \n\n' + escapeMarkdown(commit.subject)
    );
  }
  hover.appendMarkdown(
    '\n\n[$(list-tree) \uC774 \uC904\uC758 \uBCC0\uACBD \uD750\uB984]('
      + commandFactory(LINE_HISTORY_COMMAND, [sourcePath, zeroBasedLine]) + ')'
  );
  hover.appendMarkdown(
    ' | [$(history) \uD30C\uC77C \uBCC0\uACBD \uD750\uB984]('
      + commandFactory(FILE_HISTORY_COMMAND, [sourcePath]) + ')'
  );
  hover.isTrusted = { enabledCommands: TRUSTED_HOVER_COMMANDS };
  return hover;
}

export interface EditorOwnershipOptions {
  readonly onError?: (error: unknown, operation: string, path: string) => void;
  readonly scheduleRetry?: (callback: () => void) => void;
}

export class EditorOwnershipController implements vscode.Disposable {
  private committedDecoration: vscode.TextEditorDecorationType;
  private workingDecoration: vscode.TextEditorDecorationType;
  private readonly generations = new Map<string, number>();
  private readonly rendered = new WeakMap<vscode.TextEditor, string>();
  private readonly suppressedDocumentUris = new Set<string>();
  private readonly dirtyDocumentUris = new Set<string>();
  private readonly pendingSaveRefreshes = new Map<string, number>();
  private readonly saveRefreshGenerations = new Map<string, number>();
  private readonly subscriptions: vscode.Disposable[];
  private scheduled = false;
  private disposed = false;
  private enabled = true;
  private decorationRevision = 0;

  public constructor(
    private readonly registry: RepositoryRegistry,
    private readonly options: EditorOwnershipOptions = {}
  ) {
    this.committedDecoration = this.createDecoration('gitDecoration.addedResourceForeground');
    this.workingDecoration = this.createDecoration('gitDecoration.modifiedResourceForeground');
    this.subscriptions = [
      registry.onDidChange(() => this.scheduleRefresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeTextDocument(({ document }) => this.handleDocumentChange(document)),
      vscode.workspace.onDidSaveTextDocument((document) => this.resumeUri(document.uri)),
      vscode.workspace.onDidCloseTextDocument((document) => this.closeUri(document.uri))
    ];
  }

  public async refreshVisibleEditors(): Promise<void> {
    if (this.disposed || !this.enabled) return;
    await Promise.all(vscode.window.visibleTextEditors.map((editor) => this.refreshEditor(editor)));
  }

  public async refreshUri(uri: vscode.Uri): Promise<void> {
    if (this.disposed || !this.enabled || !isSourceUri(uri)) return;
    const editors = vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === uri.toString());
    await Promise.all(editors.map((editor) => this.refreshEditor(editor)));
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return;
    if (this.enabled === enabled) {
      if (enabled) await this.refreshVisibleEditors();
      return;
    }

    this.enabled = enabled;
    this.decorationRevision += 1;
    if (!enabled) {
      for (const editor of vscode.window.visibleTextEditors) {
        const key = editor.document.uri.toString();
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
        this.clear(editor);
      }
      return;
    }

    await this.refreshVisibleEditors();
  }

  public async toggleLineBackground(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('myCode');
    const enabled = configuration.get<boolean>('editor.lineBackground', false);
    await configuration.update('editor.lineBackground', !enabled, vscode.ConfigurationTarget.Global);
    if (this.disposed) return;
    this.decorationRevision += 1;
    this.committedDecoration.dispose();
    this.workingDecoration.dispose();
    this.committedDecoration = this.createDecoration('gitDecoration.addedResourceForeground');
    this.workingDecoration = this.createDecoration('gitDecoration.modifiedResourceForeground');
    await this.refreshVisibleEditors();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.committedDecoration.dispose();
    this.workingDecoration.dispose();
    this.generations.clear();
    this.dirtyDocumentUris.clear();
    this.pendingSaveRefreshes.clear();
    this.saveRefreshGenerations.clear();
    this.suppressedDocumentUris.clear();
  }

  private scheduleRefresh(): void {
    if (this.disposed || !this.enabled || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.refreshVisibleEditors();
    });
  }

  private async refreshEditor(editor: vscode.TextEditor): Promise<void> {
    const { document } = editor;
    if (!isSourceUri(document.uri)) return;
    if (!this.enabled) return;
    const key = document.uri.toString();
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);

    if (document.isDirty || this.dirtyDocumentUris.has(key) || this.pendingSaveRefreshes.has(key)
      || this.suppressedDocumentUris.has(key)) {
      this.clear(editor);
      return;
    }

    const repository = this.registry.findByUri(document.uri);
    if (repository === undefined || repository.state !== 'ready') {
      this.clear(editor);
      return;
    }
    if (!hasConfiguredIdentity(repository.analyzer.getSnapshot().identity)) {
      this.clear(editor);
      return;
    }
    const path = workspaceRelativePath(repository.root, document.uri.fsPath);
    if (path === undefined) {
      this.clear(editor);
      return;
    }

    const known = findRecord(repository.analyzer, path);
    if (known !== undefined) this.render(editor, known);
    try {
      const resolved = await repository.analyzer.ensureFile(path, 'active-editor');
      if (!this.isCurrent(key, generation)) return;
      const record = resolved ?? findRecord(repository.analyzer, path);
      if (record === undefined) this.clear(editor);
      else this.render(editor, record);
    } catch (error) {
      if (repository.analyzer.reportsErrors !== true) {
        this.options.onError?.(error, 'editor-ownership', path);
      }
    }
  }

  private isCurrent(key: string, generation: number): boolean {
    return !this.disposed && this.enabled && this.generations.get(key) === generation;
  }

  private handleDocumentChange(document: vscode.TextDocument): void {
    const { uri } = document;
    if (this.disposed || !isSourceUri(uri)) return;
    const key = uri.toString();
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === key) this.clear(editor);
    }
    if (document.isDirty) {
      this.dirtyDocumentUris.add(key);
      this.pendingSaveRefreshes.delete(key);
      return;
    }
    this.dirtyDocumentUris.delete(key);
    this.startRefresh(uri, 'editor-clean-refresh', 1);
  }

  private resumeUri(uri: vscode.Uri): void {
    if (this.disposed || !isSourceUri(uri)) return;
    this.dirtyDocumentUris.delete(uri.toString());
    this.startRefresh(uri, 'editor-save-refresh', 1);
  }

  private closeUri(uri: vscode.Uri): void {
    if (!isSourceUri(uri)) return;
    const key = uri.toString();
    this.dirtyDocumentUris.delete(key);
    this.pendingSaveRefreshes.delete(key);
    this.suppressedDocumentUris.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.saveRefreshGenerations.set(key, (this.saveRefreshGenerations.get(key) ?? 0) + 1);
  }

  private startRefresh(uri: vscode.Uri, operation: string, maxRetries: number): void {
    if (this.disposed || !isSourceUri(uri)) return;
    const key = uri.toString();
    const repository = this.registry.findByUri(uri);
    const path = repository === undefined || repository.state !== 'ready'
      ? undefined
      : workspaceRelativePath(repository.root, uri.fsPath);
    if (repository === undefined || path === undefined) return;
    const token = (this.saveRefreshGenerations.get(key) ?? 0) + 1;
    this.saveRefreshGenerations.set(key, token);
    this.pendingSaveRefreshes.set(key, token);
    this.suppressedDocumentUris.add(key);

    const run = async (attempt: number): Promise<void> => {
      let succeeded = false;
      let retry = false;
      let analyzerReported = false;
      try {
        await repository.analyzer.refresh('working-tree', [path]);
        if (this.disposed || this.pendingSaveRefreshes.get(key) !== token) return;
        try {
          await repository.analyzer.ensureFile(path, 'active-editor');
        } catch (error) {
          analyzerReported = repository.analyzer.reportsErrors === true;
          throw error;
        }
        succeeded = true;
      } catch (error) {
        if (!analyzerReported) this.options.onError?.(error, operation, path);
        retry = attempt < maxRetries;
      } finally {
        if (this.disposed || this.pendingSaveRefreshes.get(key) !== token) return;
        if (retry) {
          const schedule = this.options.scheduleRetry ?? queueMicrotask;
          schedule(() => {
            if (!this.disposed && this.pendingSaveRefreshes.get(key) === token) void run(attempt + 1);
          });
          return;
        }
        this.pendingSaveRefreshes.delete(key);
        if (!succeeded) return;
        this.suppressedDocumentUris.delete(key);
        void this.refreshUri(uri);
      }
    };
    void run(0);
  }

  private clear(editor: vscode.TextEditor): void {
    this.render(editor);
  }

  private render(editor: vscode.TextEditor, record?: FileRecord): void {
    const fingerprint = record === undefined
      ? `clear:${this.decorationRevision}`
      : `${recordFingerprint(record, this.decorationRevision)}:${editor.document.lineCount}`;
    if (this.rendered.get(editor) === fingerprint) return;
    const sourcePath = editor.document.uri.fsPath;
    const committed = record === undefined ? [] : toDecorationOptions(
      { ranges: record.ranges.filter((range) => !range.uncommitted) },
      editor.document,
      sourcePath
    );
    const working = record === undefined ? [] : toDecorationOptions(
      { ranges: record.ranges.filter((range) => range.uncommitted) },
      editor.document,
      sourcePath
    );
    editor.setDecorations(this.committedDecoration, committed);
    editor.setDecorations(this.workingDecoration, working);
    this.rendered.set(editor, fingerprint);
  }

  private createDecoration(colorId: 'gitDecoration.addedResourceForeground' | 'gitDecoration.modifiedResourceForeground'):
  vscode.TextEditorDecorationType {
    const background = vscode.workspace.getConfiguration('myCode').get<boolean>('editor.lineBackground', false);
    const committed = colorId === 'gitDecoration.addedResourceForeground';
    const icon = committed ? 'owned-committed.svg' : 'owned-working.svg';
    const backgroundColor = committed
      ? 'myCode.editor.committedLineBackground'
      : 'myCode.editor.workingLineBackground';
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: join(__dirname, '..', 'media', icon),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor(colorId),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      ...(background ? { backgroundColor: new vscode.ThemeColor(backgroundColor) } : {})
    });
  }
}

function recordFingerprint(record: FileRecord, revision: number): string {
  return JSON.stringify([
    revision,
    record.relativePath,
    record.ranges.map((range) => [
      range.start,
      range.endExclusive,
      range.uncommitted,
      range.commit?.hash,
      range.commit?.authoredAt,
      range.commit?.subject
    ])
  ]);
}

export function historyPreviewMarkdown(
  preview: HistoryPreview,
  uri: vscode.Uri,
  zeroBasedLine: number,
  commandFactory: CommandFactory = commandUri
): vscode.MarkdownString {
  const hover = new vscode.MarkdownString();
  const range = preview.ownedRange;
  if (range.commit === undefined) {
    hover.appendMarkdown('**Your uncommitted work**');
  } else {
    const commit = range.commit;
    const date = new Date(commit.authoredAt * 1_000).toLocaleDateString();
    const author = `${commit.authorName} <${commit.authorEmail}>`;
    hover.appendMarkdown(`**Your commit**  \n\n${escapeMarkdown(author)}  \n\n\`${escapeMarkdown(commit.hash.slice(0, 7))}\` · ${escapeMarkdown(date)}  \n\n${escapeMarkdown(commit.subject)}`);
  }
  appendHistory(hover, 'Line history', preview.lineHistory);
  appendHistory(hover, 'File history', preview.fileHistory);
  hover.appendMarkdown(`\n\n[$(history) File history](${commandFactory(FILE_HISTORY_COMMAND, [uri.fsPath])})`);
  hover.appendMarkdown(`\n\n[$(list-tree) Line history](${commandFactory(LINE_HISTORY_COMMAND, [uri.fsPath, zeroBasedLine])})`);
  hover.isTrusted = { enabledCommands: TRUSTED_HOVER_COMMANDS };
  return hover;
}

function appendHistory(hover: vscode.MarkdownString, title: string, commits: readonly HistoryPreview['fileHistory'][number][]): void {
  hover.appendMarkdown('\n\n---\n\n**' + title + '**');
  if (commits.length === 0) {
    hover.appendMarkdown('\n\n_No matching commits_');
    return;
  }
  for (const commit of commits.slice(0, 3)) {
    const date = new Date(commit.authoredAt * 1_000).toLocaleDateString();
    hover.appendMarkdown('\n\n- `' + escapeMarkdown(commit.hash.slice(0, 7)) + '` · ' + escapeMarkdown(date) + ' — ' + escapeMarkdown(commit.subject));
  }
}
function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|-])/g, '\\$1');
}

function isSourceUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file';
}

function findRecord(analyzer: AnalyzerAccess, path: string): FileRecord | undefined {
  return analyzer.getSnapshot().files.find((record) => record.relativePath === path);
}

function workspaceRelativePath(root: string, path: string): string | undefined {
  const candidate = relative(root, path);
  if (candidate === '' || isAbsolute(candidate) || candidate === '..' || candidate.startsWith(`..${sep}`)) return undefined;
  return sep === '/' ? candidate : candidate.split(sep).join('/');
}
