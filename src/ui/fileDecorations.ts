import { isAbsolute, relative, sep } from 'node:path';

import * as vscode from 'vscode';

import type { AnalyzerAccess, RepositoryRegistry } from '../extension/repositoryRegistry.js';

export class MyCodeDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  private readonly pending = new Set<string>();
  private readonly subscription: vscode.Disposable;

  public readonly onDidChangeFileDecorations = this.emitter.event;

  public constructor(private readonly registry: RepositoryRegistry) {
    this.subscription = registry.onDidChange(() => this.emitter.fire(undefined));
  }

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const repository = this.registry.findByUri(uri);
    if (repository === undefined || repository.state !== 'ready') return undefined;
    const path = workspaceRelativePath(repository.root, uri.fsPath);
    if (path === undefined) return undefined;
    const file = repository.analyzer.getSnapshot().files
      .find((candidate) => candidate.relativePath === path);
    if (file?.kind === 'added') return decoration('A', 'Added by you', 'gitDecoration.addedResourceForeground');
    if (file?.kind === 'modified') return decoration('M', 'Modified by you', 'gitDecoration.modifiedResourceForeground');
    if (file?.exists) this.ensureResolved(repository.analyzer, path, uri);
    return undefined;
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
    this.pending.clear();
  }

  private ensureResolved(
    analyzer: AnalyzerAccess,
    path: string,
    uri: vscode.Uri
  ): void {
    const key = uri.toString();
    if (this.pending.has(key)) return;
    this.pending.add(key);
    void analyzer.ensureFile(path, 'explorer').then(
      () => this.emitter.fire(uri),
      () => this.emitter.fire(uri)
    ).finally(() => this.pending.delete(key));
  }
}

function decoration(
  badge: 'A' | 'M',
  tooltip: string,
  color: 'gitDecoration.addedResourceForeground' | 'gitDecoration.modifiedResourceForeground'
): vscode.FileDecoration {
  const value = new vscode.FileDecoration(badge, tooltip, new vscode.ThemeColor(color));
  value.propagate = true;
  return value;
}

function workspaceRelativePath(root: string, path: string): string | undefined {
  const candidate = relative(root, path);
  if (candidate === '' || isAbsolute(candidate) || isParentTraversal(candidate)) return undefined;
  return sep === '/' ? candidate : candidate.split(sep).join('/');
}

function isParentTraversal(path: string): boolean {
  return path === '..' || path.startsWith(`..${sep}`);
}
