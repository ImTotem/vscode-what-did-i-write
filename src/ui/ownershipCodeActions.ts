import { isAbsolute, relative, sep } from 'node:path';

import * as vscode from 'vscode';

import { hasConfiguredIdentity } from '../core/identity.js';
import { localize } from '../localization.js';
import type { RepositoryRegistry } from '../extension/repositoryRegistry.js';

export class OwnershipCodeActionProvider implements vscode.CodeActionProvider {
  public constructor(
    private readonly registry: RepositoryRegistry,
    private readonly isDocumentSnapshotCurrent: (document: vscode.TextDocument) => boolean = (document) => !document.isDirty
  ) {}

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.CodeAction[] {
    const visualsEnabled = vscode.workspace.getConfiguration('myCode').get<boolean>('visuals.enabled', true);
    if (!visualsEnabled) return [];
    if (!this.isDocumentSnapshotCurrent(document)) return [];

    const repository = this.registry.findByUri(document.uri);
    if (repository === undefined || repository.state !== 'ready') return [];
    const snapshot = repository.analyzer.getSnapshot();
    if (!hasConfiguredIdentity(snapshot.identity)) return [];
    const path = workspaceRelativePath(repository.root, document.uri.fsPath);
    if (path === undefined) return [];
    const record = snapshot.files.find((candidate) => candidate.relativePath === path);
    const line = range.start.line;
    if (record === undefined || !record.ranges.some((owned) => isOwnedLine(owned, line))) return [];

    const lineTitle = localize('Line history');
    const fileTitle = localize('File history');
    const lineAction = new vscode.CodeAction(lineTitle, vscode.CodeActionKind.QuickFix);
    lineAction.isPreferred = true;
    lineAction.command = {
      command: 'myCode.focusLineHistory',
      title: lineTitle,
      arguments: [document.uri.fsPath, line]
    };

    const fileAction = new vscode.CodeAction(fileTitle, vscode.CodeActionKind.QuickFix);
    fileAction.command = {
      command: 'myCode.focusFileHistory',
      title: fileTitle,
      arguments: [document.uri.fsPath]
    };
    return [lineAction, fileAction];
  }
}

function isOwnedLine(range: { readonly start: number; readonly endExclusive: number }, line: number): boolean {
  return line >= range.start && line < range.endExclusive;
}

function workspaceRelativePath(root: string, path: string): string | undefined {
  const candidate = relative(root, path);
  if (candidate === '' || isAbsolute(candidate) || candidate === '..' || candidate.startsWith(`..${sep}`)) return undefined;
  return sep === '/' ? candidate : candidate.split(sep).join('/');
}
