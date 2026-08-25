import { basename, join } from 'node:path';

import * as vscode from 'vscode';

import type { CommitSummary, FileRecord, RepositorySnapshot } from '../core/model.js';
import type { RepositoryRegistry } from '../extension/repositoryRegistry.js';

export type MyCodeNode = RepositoryTreeNode | GroupTreeNode | FileTreeNode | HistoryTreeNode;

interface TreeNodeBase {
  readonly label: string;
  readonly children: readonly MyCodeNode[];
  readonly badge?: 'A' | 'M' | '◷';
}

export interface RepositoryTreeNode extends TreeNodeBase {
  readonly kind: 'repository';
  readonly root: string;
}

export interface GroupTreeNode extends TreeNodeBase {
  readonly kind: 'group';
  readonly group: 'current' | 'past';
  readonly root: string;
}

export interface FileTreeNode extends TreeNodeBase {
  readonly kind: 'file';
  readonly root: string;
  readonly file: FileRecord;
}

export interface HistoryTreeNode extends TreeNodeBase {
  readonly kind: 'history';
  readonly root: string;
  readonly relativePath: string;
  readonly commit: CommitSummary;
}

export function projectTree(snapshots: readonly RepositorySnapshot[]): readonly MyCodeNode[] {
  const repositories = [...snapshots]
    .sort((left, right) => left.root.localeCompare(right.root))
    .map(projectRepository);
  return repositories.length === 1 ? repositories[0]?.children ?? [] : repositories;
}

export class MyCodeTreeProvider implements vscode.TreeDataProvider<MyCodeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<MyCodeNode | undefined>();
  private readonly subscription: vscode.Disposable;

  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly registry: RepositoryRegistry) {
    this.subscription = registry.onDidChange(() => this.emitter.fire(undefined));
  }

  public getTreeItem(element: MyCodeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'repository':
        return new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      case 'group':
        return new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      case 'file':
        return this.fileTreeItem(element);
      case 'history':
        return this.historyTreeItem(element);
    }
  }

  public getChildren(element?: MyCodeNode): MyCodeNode[] {
    if (element === undefined) {
      return [...projectTree(this.registry.repositories
        .filter(({ state }) => state === 'ready')
        .map(({ analyzer }) => analyzer.getSnapshot()))];
    }
    if (element.kind === 'file') return [...historyNodes(element)];
    return [...element.children];
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  private fileTreeItem(node: FileTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.file.history.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.description = node.badge;
    item.tooltip = node.file.relativePath;
    if (node.file.exists) {
      item.resourceUri = fileUri(node);
      item.command = {
        command: 'myCode.openFile',
        title: 'Open File',
        arguments: [node]
      };
    }
    item.contextValue = node.file.exists ? 'myCode.file' : 'myCode.pastFile';
    if (!node.file.exists && node.file.kind === 'past') item.iconPath = new vscode.ThemeIcon('history');
    return item;
  }

  private historyTreeItem(node: HistoryTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.commit.hash.slice(0, 7);
    item.tooltip = [
      node.commit.hash,
      `${node.commit.authorName} <${node.commit.authorEmail}>`,
      new Date(node.commit.authoredAt * 1_000).toLocaleString(),
      node.commit.subject
    ].join('\n');
    item.command = {
      command: 'myCode.openCommitDiff',
      title: 'Open Commit Diff',
      arguments: [node]
    };
    item.contextValue = 'myCode.history';
    return item;
  }
}

export function fileUri(node: FileTreeNode): vscode.Uri {
  return vscode.Uri.file(join(node.root, node.file.relativePath));
}

function projectRepository(snapshot: RepositorySnapshot): RepositoryTreeNode {
  const current = snapshot.files
    .filter(({ kind }) => kind === 'added' || kind === 'modified')
    .sort(compareFiles)
    .map((file) => fileNode(snapshot.root, file));
  const past = snapshot.files
    .filter(({ kind }) => kind === 'past')
    .sort(compareFiles)
    .map((file) => fileNode(snapshot.root, file));
  const children: readonly GroupTreeNode[] = [
    { kind: 'group', group: 'current', root: snapshot.root, label: 'CURRENT', children: current },
    { kind: 'group', group: 'past', root: snapshot.root, label: 'PAST ACTIVITY', children: past }
  ];
  return { kind: 'repository', root: snapshot.root, label: basename(snapshot.root), children };
}

function fileNode(root: string, file: FileRecord): FileTreeNode {
  return {
    kind: 'file',
    root,
    file,
    label: file.relativePath,
    badge: file.kind === 'added' ? 'A' : file.kind === 'modified' ? 'M' : '◷',
    children: []
  };
}

function historyNodes(node: FileTreeNode): readonly HistoryTreeNode[] {
  return node.file.history.map((commit) => ({
    kind: 'history',
    root: node.root,
    relativePath: node.file.relativePath,
    commit,
    label: commit.subject,
    children: []
  }));
}

function compareFiles(left: FileRecord, right: FileRecord): number {
  return left.relativePath.localeCompare(right.relativePath);
}
