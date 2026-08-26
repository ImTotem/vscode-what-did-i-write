import { basename, dirname, join } from 'node:path';

import * as vscode from 'vscode';

import { hasConfiguredIdentity } from '../core/identity.js';
import type { CommitSummary, FileRecord, RepositorySnapshot } from '../core/model.js';
import type { RepositoryRegistry } from '../extension/repositoryRegistry.js';

export type MyCodeNode = RepositoryTreeNode | GroupTreeNode | FolderTreeNode | FileTreeNode;

interface TreeNodeBase {
  readonly id: string;
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

export interface FolderTreeNode extends TreeNodeBase {
  readonly kind: 'folder';
  readonly group?: 'current' | 'past';
  readonly root: string;
  readonly relativePath: string;
}

export interface FileTreeNode extends TreeNodeBase {
  readonly kind: 'file';
  readonly root: string;
  readonly file: FileRecord;
}

export interface HistoryTreeNode {
  readonly kind: 'history';
  readonly id: string;
  readonly root: string;
  readonly relativePath: string;
  readonly commit: CommitSummary;
  readonly label: string;
  readonly children: readonly MyCodeNode[];
}

export interface PastActivityNode {
  readonly kind: 'past';
  readonly id: string;
  readonly root: string;
  readonly relativePath: string;
  readonly file: FileRecord;
  readonly label: string;
  readonly parentPath: string;
  readonly latestCommit: CommitSummary | undefined;
  readonly children: readonly [];
}

export function projectCurrentTree(snapshots: readonly RepositorySnapshot[]): readonly MyCodeNode[] {
  const repositories = [...snapshots]
    .sort((left, right) => left.root.localeCompare(right.root))
    .map((snapshot) => currentRepository(snapshot))
    .filter(({ children }) => children.length > 0);
  return snapshots.length === 1 ? repositories[0]?.children ?? [] : repositories;
}

export function projectPastActivity(snapshots: readonly RepositorySnapshot[]): readonly PastActivityNode[] {
  return snapshots
    .flatMap((snapshot) => snapshot.files
      .filter(({ kind }) => kind === 'past')
      .map((file) => pastNode(snapshot.root, file)))
    .sort((left, right) => (right.latestCommit?.authoredAt ?? 0) - (left.latestCommit?.authoredAt ?? 0)
      || left.root.localeCompare(right.root)
      || left.relativePath.localeCompare(right.relativePath));
}

/** @deprecated Use projectCurrentTree and projectPastActivity for the split views. */
export function projectTree(snapshots: readonly RepositorySnapshot[]): readonly MyCodeNode[] {
  const repositories = [...snapshots]
    .sort((left, right) => left.root.localeCompare(right.root))
    .map(legacyRepository)
    .filter(({ children }) => children.length > 0);
  return snapshots.length === 1 ? repositories[0]?.children ?? [] : repositories;
}

export class MyCodeTreeProvider implements vscode.TreeDataProvider<MyCodeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<MyCodeNode | undefined>();
  private readonly subscription: vscode.Disposable;
  private graph: CurrentGraph | undefined;

  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly registry: RepositoryRegistry) {
    this.subscription = registry.onDidChange(() => {
      this.graph = undefined;
      this.emitter.fire(undefined);
    });
  }

  public getTreeItem(element: MyCodeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'repository':
      case 'group':
        return new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      case 'folder':
        return this.folderTreeItem(element);
      case 'file':
        return this.fileTreeItem(element);
    }
  }

  public getChildren(element?: MyCodeNode): MyCodeNode[] {
    const graph = this.currentGraph();
    return element === undefined ? [...graph.roots] : [...element.children];
  }

  public getParent(element: MyCodeNode): MyCodeNode | undefined {
    return this.currentGraph().parents.get(element.id);
  }

  public expandableNodes(): readonly MyCodeNode[] {
    return this.currentGraph().expandable;
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  private currentGraph(): CurrentGraph {
    const snapshots = readySnapshots(this.registry);
    const signature = snapshotSignature(snapshots);
    if (this.graph?.signature === signature) return this.graph;
    this.graph = currentGraph(signature, projectCurrentTree(snapshots));
    return this.graph;
  }

  private folderTreeItem(node: FolderTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.resourceUri = vscode.Uri.file(join(node.root, node.relativePath));
    item.contextValue = 'myCode.folder';
    return item;
  }

  private fileTreeItem(node: FileTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.badge;
    item.tooltip = node.file.relativePath;
    if (node.file.exists) {
      item.resourceUri = fileUri(node);
      item.command = { command: 'myCode.openFile', title: 'Open File', arguments: [node] };
    } else {
      item.command = { command: 'myCode.focusFileHistory', title: 'Show File History', arguments: [node] };
    }
    item.contextValue = node.file.exists ? 'myCode.file' : 'myCode.pastFile';
    return item;
  }
}

export class PastActivityTreeProvider implements vscode.TreeDataProvider<PastActivityNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<PastActivityNode | undefined>();
  private readonly subscription: vscode.Disposable;
  private graph: PastGraph | undefined;

  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly registry: RepositoryRegistry) {
    this.subscription = registry.onDidChange(() => {
      this.graph = undefined;
      this.emitter.fire(undefined);
    });
  }

  public getTreeItem(element: PastActivityNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = pastDescription(element);
    item.tooltip = element.relativePath;
    item.command = { command: 'myCode.focusFileHistory', title: 'Show File History', arguments: [join(element.root, element.relativePath)] };
    item.contextValue = 'myCode.pastFile';
    item.iconPath = new vscode.ThemeIcon('history');
    return item;
  }

  public getChildren(element?: PastActivityNode): PastActivityNode[] {
    return element === undefined ? [...this.currentGraph().roots] : [];
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  private currentGraph(): PastGraph {
    const snapshots = readySnapshots(this.registry);
    const signature = snapshotSignature(snapshots);
    if (this.graph?.signature === signature) return this.graph;
    const roots = projectPastActivity(snapshots);
    this.graph = { signature, roots, nodes: new Map(roots.map((node) => [node.id, node])) };
    return this.graph;
  }
}

export function fileUri(node: FileTreeNode): vscode.Uri {
  return vscode.Uri.file(join(node.root, node.file.relativePath));
}

interface CurrentGraph {
  readonly signature: string;
  readonly roots: readonly MyCodeNode[];
  readonly nodes: ReadonlyMap<string, MyCodeNode>;
  readonly parents: ReadonlyMap<string, MyCodeNode>;
  readonly expandable: readonly MyCodeNode[];
}

interface PastGraph {
  readonly signature: string;
  readonly roots: readonly PastActivityNode[];
  readonly nodes: ReadonlyMap<string, PastActivityNode>;
}

function currentGraph(signature: string, roots: readonly MyCodeNode[]): CurrentGraph {
  const nodes = new Map<string, MyCodeNode>();
  const parents = new Map<string, MyCodeNode>();
  const expandable: MyCodeNode[] = [];
  const visit = (node: MyCodeNode, parent?: MyCodeNode): void => {
    nodes.set(node.id, node);
    if (parent !== undefined) parents.set(node.id, parent);
    if (node.children.length > 0) expandable.push(node);
    for (const child of node.children) visit(child, node);
  };
  for (const root of roots) visit(root);
  return { signature, roots, nodes, parents, expandable };
}

function readySnapshots(registry: RepositoryRegistry): readonly RepositorySnapshot[] {
  return registry.repositories
    .filter(({ state }) => state === 'ready')
    .map(({ analyzer }) => analyzer.getSnapshot())
    .filter(({ identity }) => hasConfiguredIdentity(identity));
}

function snapshotSignature(snapshots: readonly RepositorySnapshot[]): string {
  return snapshots
    .map(({ root, generatedAt }) => `${root}\0${generatedAt}`)
    .sort((left, right) => left.localeCompare(right))
    .join('\0');
}

function currentRepository(snapshot: RepositorySnapshot): RepositoryTreeNode {
  return {
    id: `repository|${snapshot.root}`,
    kind: 'repository',
    root: snapshot.root,
    label: basename(snapshot.root),
    children: folderTree(snapshot.root, snapshot.files.filter(isCurrent))
  };
}

function legacyRepository(snapshot: RepositorySnapshot): RepositoryTreeNode {
  const current = snapshot.files.filter(isCurrent);
  const past = snapshot.files.filter(({ kind }) => kind === 'past');
  const children: GroupTreeNode[] = [];
  if (current.length > 0) children.push({
    id: `group|${snapshot.root}|current`, kind: 'group', group: 'current', root: snapshot.root,
    label: 'CURRENT', children: folderTree(snapshot.root, current, 'current')
  });
  if (past.length > 0) children.push({
    id: `group|${snapshot.root}|past`, kind: 'group', group: 'past', root: snapshot.root,
    label: 'PAST ACTIVITY', children: folderTree(snapshot.root, past, 'past')
  });
  return { id: `repository|${snapshot.root}`, kind: 'repository', root: snapshot.root, label: basename(snapshot.root), children };
}

function isCurrent(file: FileRecord): boolean {
  return file.kind === 'added' || file.kind === 'modified';
}

interface MutableFolder {
  readonly name: string;
  readonly relativePath: string;
  readonly folders: Map<string, MutableFolder>;
  readonly files: FileRecord[];
}

function folderTree(root: string, files: readonly FileRecord[], group?: 'current' | 'past'): readonly MyCodeNode[] {
  const treeRoot: MutableFolder = { name: '', relativePath: '', folders: new Map(), files: [] };
  for (const file of [...files].sort(compareFiles)) {
    const segments = file.relativePath.split('/').filter((segment) => segment.length > 0);
    const fileName = segments.pop();
    if (fileName === undefined) continue;
    let folder = treeRoot;
    for (const segment of segments) {
      const relativePath = folder.relativePath === '' ? segment : `${folder.relativePath}/${segment}`;
      let child = folder.folders.get(segment);
      if (child === undefined) {
        child = { name: segment, relativePath, folders: new Map(), files: [] };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  return folderChildren(root, treeRoot, group);
}

function folderChildren(root: string, folder: MutableFolder, group?: 'current' | 'past'): readonly MyCodeNode[] {
  const folders: FolderTreeNode[] = [...folder.folders.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child) => ({
      id: `folder|${root}|${child.relativePath}`,
      kind: 'folder',
      ...(group === undefined ? {} : { group }),
      root,
      relativePath: child.relativePath,
      label: child.name,
      children: folderChildren(root, child, group)
    }));
  return [...folders, ...folder.files.sort(compareFiles).map((file) => fileNode(root, file))];
}

function fileNode(root: string, file: FileRecord): FileTreeNode {
  return {
    id: `file|${root}|${file.relativePath}`,
    kind: 'file',
    root,
    file,
    label: basename(file.relativePath),
    badge: file.kind === 'added' ? 'A' : file.kind === 'modified' ? 'M' : '◷',
    children: []
  };
}

function pastNode(root: string, file: FileRecord): PastActivityNode {
  const latestCommit = file.history.reduce<CommitSummary | undefined>((latest, commit) =>
    latest === undefined || commit.authoredAt > latest.authoredAt ? commit : latest, undefined);
  return {
    id: `past|${root}|${file.relativePath}`,
    kind: 'past',
    root,
    relativePath: file.relativePath,
    file,
    label: basename(file.relativePath),
    parentPath: dirname(file.relativePath),
    latestCommit,
    children: []
  };
}

function pastDescription(node: PastActivityNode): string {
  const latestTime = node.latestCommit === undefined ? 'Unknown time' : new Date(node.latestCommit.authoredAt * 1_000).toLocaleString();
  return `${node.parentPath} · ${latestTime}`;
}

function compareFiles(left: FileRecord, right: FileRecord): number {
  return left.relativePath.localeCompare(right.relativePath);
}