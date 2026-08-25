import { isAbsolute, relative, sep } from 'node:path';

import * as vscode from 'vscode';

import type { FileRecord, OwnedRange } from '../core/model.js';
import type { AnalyzerAccess, RepositoryRegistry } from '../extension/repositoryRegistry.js';

const FILE_HISTORY_COMMAND = 'myCode.showFileHistory';
const LINE_HISTORY_COMMAND = 'myCode.showLineHistory';
const TRUSTED_HOVER_COMMANDS = [FILE_HISTORY_COMMAND, LINE_HISTORY_COMMAND] as const;

export type CommandFactory = (command: string, args: readonly unknown[]) => string;

export function commandUri(command: string, args: readonly unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

export function toDecorationOptions(
  record: Pick<FileRecord, 'ranges'>,
  document: Pick<vscode.TextDocument, 'lineCount' | 'uri'>,
  commandFactory: CommandFactory = commandUri
): vscode.DecorationOptions[] {
  return record.ranges.flatMap((ownedRange) => {
    const range = documentRange(ownedRange, document.lineCount);
    if (range === undefined) return [];
    return [{ range, hoverMessage: hoverMessage(ownedRange, document.uri, commandFactory) }];
  });
}

export function documentRange(range: Pick<OwnedRange, 'start' | 'endExclusive'>, lineCount: number): vscode.Range | undefined {
  const safeLineCount = Math.max(0, lineCount);
  const start = Math.min(Math.max(0, range.start), safeLineCount);
  const end = Math.min(Math.max(start, range.endExclusive), safeLineCount);
  if (start === end) return undefined;
  return new vscode.Range(new vscode.Position(start, 0), new vscode.Position(end, 0));
}

export class EditorOwnershipController implements vscode.Disposable {
  private committedDecoration: vscode.TextEditorDecorationType;
  private workingDecoration: vscode.TextEditorDecorationType;
  private readonly generations = new Map<string, number>();
  private readonly dirtyDocumentUris = new Set<string>();
  private readonly subscriptions: vscode.Disposable[];
  private scheduled = false;
  private disposed = false;

  public constructor(private readonly registry: RepositoryRegistry) {
    this.committedDecoration = this.createDecoration('gitDecoration.addedResourceForeground');
    this.workingDecoration = this.createDecoration('gitDecoration.modifiedResourceForeground');
    this.subscriptions = [
      registry.onDidChange(() => this.scheduleRefresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeTextDocument(({ document }) => this.invalidateUri(document.uri)),
      vscode.workspace.onDidSaveTextDocument((document) => this.resumeUri(document.uri))
    ];
  }

  public async refreshVisibleEditors(): Promise<void> {
    if (this.disposed) return;
    await Promise.all(vscode.window.visibleTextEditors.map((editor) => this.refreshEditor(editor)));
  }

  public async refreshUri(uri: vscode.Uri): Promise<void> {
    if (this.disposed || !isSourceUri(uri)) return;
    const editors = vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === uri.toString());
    await Promise.all(editors.map((editor) => this.refreshEditor(editor)));
  }

  public async toggleLineBackground(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('myCode');
    const enabled = configuration.get<boolean>('editor.lineBackground', false);
    await configuration.update('editor.lineBackground', !enabled, vscode.ConfigurationTarget.Global);
    if (this.disposed) return;
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
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.refreshVisibleEditors();
    });
  }

  private async refreshEditor(editor: vscode.TextEditor): Promise<void> {
    const { document } = editor;
    if (!isSourceUri(document.uri)) return;
    const key = document.uri.toString();
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    this.clear(editor);

    if (this.dirtyDocumentUris.has(key)) return;

    const repository = this.registry.findByUri(document.uri);
    if (repository === undefined || repository.state !== 'ready') return;
    const path = workspaceRelativePath(repository.root, document.uri.fsPath);
    if (path === undefined) return;

    const known = findRecord(repository.analyzer, path);
    if (known !== undefined) this.apply(editor, known);
    try {
      const resolved = await repository.analyzer.ensureFile(path, 'active-editor');
      if (!this.isCurrent(key, generation)) return;
      const record = resolved ?? findRecord(repository.analyzer, path);
      this.clear(editor);
      if (record !== undefined) this.apply(editor, record);
    } catch {
      if (this.isCurrent(key, generation)) this.clear(editor);
    }
  }

  private isCurrent(key: string, generation: number): boolean {
    return !this.disposed && this.generations.get(key) === generation;
  }

  private invalidateUri(uri: vscode.Uri): void {
    if (this.disposed || !isSourceUri(uri)) return;
    const key = uri.toString();
    this.dirtyDocumentUris.add(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === key) this.clear(editor);
    }
  }

  private resumeUri(uri: vscode.Uri): void {
    if (this.disposed || !isSourceUri(uri)) return;
    this.dirtyDocumentUris.delete(uri.toString());
    void this.refreshUri(uri);
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.committedDecoration, []);
    editor.setDecorations(this.workingDecoration, []);
  }

  private apply(editor: vscode.TextEditor, record: FileRecord): void {
    const committed = toDecorationOptions({ ranges: record.ranges.filter((range) => !range.uncommitted) }, editor.document);
    const working = toDecorationOptions({ ranges: record.ranges.filter((range) => range.uncommitted) }, editor.document);
    editor.setDecorations(this.committedDecoration, committed);
    editor.setDecorations(this.workingDecoration, working);
  }

  private createDecoration(colorId: 'gitDecoration.addedResourceForeground' | 'gitDecoration.modifiedResourceForeground'):
  vscode.TextEditorDecorationType {
    const background = vscode.workspace.getConfiguration('myCode').get<boolean>('editor.lineBackground', false);
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 0 2px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor(colorId),
      overviewRulerColor: new vscode.ThemeColor(colorId),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      ...(background ? { backgroundColor: new vscode.ThemeColor(colorId) } : {})
    });
  }
}

function hoverMessage(range: OwnedRange, uri: vscode.Uri, commandFactory: CommandFactory): vscode.MarkdownString {
  const hover = new vscode.MarkdownString();
  if (range.commit === undefined) {
    hover.appendMarkdown('**Your uncommitted work**');
  } else {
    const commit = range.commit;
    const date = new Date(commit.authoredAt * 1_000).toLocaleDateString();
    const author = `${commit.authorName} <${commit.authorEmail}>`;
    hover.appendMarkdown(`**Your commit**  \n\n${escapeMarkdown(author)}  \n\n\`${escapeMarkdown(commit.hash.slice(0, 7))}\` · ${escapeMarkdown(date)}  \n\n${escapeMarkdown(commit.subject)}`);
  }
  hover.appendMarkdown(`\n\n[$(history) File history](${commandFactory(FILE_HISTORY_COMMAND, [uri.fsPath])})`);
  hover.appendMarkdown(`\n\n[$(list-tree) Line history](${commandFactory(LINE_HISTORY_COMMAND, [uri.fsPath, range.start])})`);
  hover.isTrusted = { enabledCommands: TRUSTED_HOVER_COMMANDS };
  return hover;
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
