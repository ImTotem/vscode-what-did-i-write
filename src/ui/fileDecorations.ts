import { isAbsolute, relative, sep } from 'node:path';

import * as vscode from 'vscode';

import { hasConfiguredIdentity } from '../core/identity.js';
import type { FileRecord } from '../core/model.js';
import { localize } from '../localization.js';
import type { AnalyzerAccess, RepositoryRegistry } from '../extension/repositoryRegistry.js';

type CurrentKind = Extract<FileRecord['kind'], 'added' | 'modified'>;

export class MyCodeDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  private readonly pending = new Set<string>();
  private readonly subscription: vscode.Disposable;
  private enabled = true;
  private visualFingerprint: string;

  public readonly onDidChangeFileDecorations = this.emitter.event;

  public constructor(
    private readonly registry: RepositoryRegistry,
    private readonly onError?: (error: unknown, operation: string, path: string) => void
  ) {
    this.visualFingerprint = decorationFingerprint(registry);
    this.subscription = registry.onDidChange(() => this.acceptRegistryChange());
  }

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.enabled) return undefined;
    const repository = this.registry.findByUri(uri);
    if (repository === undefined || repository.state !== 'ready') return undefined;
    const path = workspaceRelativePath(repository.root, uri.fsPath);
    if (path === undefined) return undefined;
    const snapshot = repository.analyzer.getSnapshot();
    if (!hasConfiguredIdentity(snapshot.identity)) return undefined;

    const file = snapshot.files.find((candidate) => candidate.relativePath === path);
    if (file?.kind === 'added') return fileDecoration('added');
    if (file?.kind === 'modified') return fileDecoration('modified');
    if (file?.exists) {
      this.ensureResolved(repository.analyzer, path, uri);
      return undefined;
    }

    const descendantKinds = snapshot.files
      .filter((candidate) => isDescendant(candidate.relativePath, path))
      .map(({ kind }) => kind)
      .filter((kind): kind is CurrentKind => kind === 'added' || kind === 'modified');
    const aggregate = descendantKinds.includes('modified')
      ? 'modified'
      : descendantKinds.includes('added') ? 'added' : undefined;
    return aggregate === undefined ? undefined : folderDecoration(aggregate);
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.emitter.fire(undefined);
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
    this.pending.clear();
  }

  private acceptRegistryChange(): void {
    const next = decorationFingerprint(this.registry);
    if (next === this.visualFingerprint) return;
    this.visualFingerprint = next;
    this.emitter.fire(undefined);
  }

  private ensureResolved(analyzer: AnalyzerAccess, path: string, uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.pending.has(key)) return;
    this.pending.add(key);
    void analyzer.ensureFile(path, 'explorer').then(
      () => this.emitter.fire(uri),
      (error: unknown) => {
        if (analyzer.reportsErrors !== true) this.onError?.(error, 'explorer-ownership', path);
        this.emitter.fire(uri);
      }
    ).finally(() => this.pending.delete(key));
  }
}

function fileDecoration(kind: CurrentKind): vscode.FileDecoration {
  return decoration(
    kind === 'added' ? 'A' : 'M',
    localize(kind === 'added' ? 'Added by you' : 'Modified by you'),
    colorFor(kind)
  );
}

function folderDecoration(kind: CurrentKind): vscode.FileDecoration {
  return decoration(
    undefined,
    localize(kind === 'added' ? 'Contains code added by you' : 'Contains code modified by you'),
    colorFor(kind)
  );
}

function decoration(
  badge: string | undefined,
  tooltip: string,
  color: 'gitDecoration.addedResourceForeground' | 'gitDecoration.modifiedResourceForeground'
): vscode.FileDecoration {
  const value = new vscode.FileDecoration(badge, tooltip, new vscode.ThemeColor(color));
  value.propagate = true;
  return value;
}

function colorFor(kind: CurrentKind):
'gitDecoration.addedResourceForeground' | 'gitDecoration.modifiedResourceForeground' {
  return kind === 'added'
    ? 'gitDecoration.addedResourceForeground'
    : 'gitDecoration.modifiedResourceForeground';
}

function isDescendant(candidate: string, directory: string): boolean {
  return directory === '' ? candidate.length > 0 : candidate.startsWith(`${directory}/`);
}

function workspaceRelativePath(root: string, path: string): string | undefined {
  const candidate = relative(root, path);
  if (isAbsolute(candidate) || isParentTraversal(candidate)) return undefined;
  if (candidate === '') return '';
  return sep === '/' ? candidate : candidate.split(sep).join('/');
}

function isParentTraversal(path: string): boolean {
  return path === '..' || path.startsWith(`..${sep}`);
}

function decorationFingerprint(registry: RepositoryRegistry): string {
  return JSON.stringify(registry.repositories.flatMap((repository) => {
    if (repository.state !== 'ready') return [];
    const snapshot = repository.analyzer.getSnapshot();
    if (!hasConfiguredIdentity(snapshot.identity)) return [];
    return snapshot.files
      .filter(({ kind }) => kind === 'added' || kind === 'modified')
      .map(({ relativePath, kind }) => [repository.root, relativePath, kind] as const);
  }).sort((left, right) => {
    const byRoot = left[0].localeCompare(right[0]);
    return byRoot !== 0 ? byRoot : left[1].localeCompare(right[1]);
  }));
}
