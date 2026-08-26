import { dirname, isAbsolute, join, resolve } from 'node:path';

import * as vscode from 'vscode';

import type { MyCodeFileActionNode, MyCodeFileActions } from './myCodeFileActions.js';
import type { MyCodeNode } from './myCodeTree.js';

export const MY_CODE_TREE_MIME = 'application/vnd.code.tree.mycode.explorer';
const URI_LIST_MIME = 'text/uri-list';

type CurrentTreeResolver = Pick<{ resolveNode(id: string): MyCodeNode | undefined }, 'resolveNode'>;
type FileTransferActions = Pick<MyCodeFileActions, 'copyOrMove' | 'copyExternal'>;

export class MyCodeDragAndDropController implements vscode.TreeDragAndDropController<MyCodeFileActionNode> {
  public readonly dragMimeTypes = [MY_CODE_TREE_MIME, URI_LIST_MIME];
  public readonly dropMimeTypes = [MY_CODE_TREE_MIME, URI_LIST_MIME];

  public constructor(
    private readonly provider: CurrentTreeResolver,
    private readonly actions: FileTransferActions
  ) {}

  public async handleDrag(
    source: readonly MyCodeFileActionNode[],
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (token.isCancellationRequested) return;
    const current = source.filter(isCurrentDragNode);
    if (current.length === 0) return;
    dataTransfer.set(
      MY_CODE_TREE_MIME,
      new vscode.DataTransferItem(JSON.stringify(current.map(({ id }) => id)))
    );
    dataTransfer.set(
      URI_LIST_MIME,
      new vscode.DataTransferItem(current.map((node) => vscode.Uri.file(nodeAbsolutePath(node)).toString()).join('\r\n'))
    );
  }

  public async handleDrop(
    target: MyCodeFileActionNode | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (token.isCancellationRequested || target === undefined || !isCurrentDragNode(target)) return;
    const currentTarget = this.provider.resolveNode(target.id);
    if (currentTarget === undefined || !isCurrentDragNode(currentTarget)) return;

    const internalItem = dataTransfer.get(MY_CODE_TREE_MIME);
    if (internalItem !== undefined) {
      const ids = await parseStableIds(internalItem);
      if (token.isCancellationRequested) return;
      const sources = ids
        .map((id) => this.provider.resolveNode(id))
        .filter((node): node is MyCodeNode => node !== undefined && isCurrentDragNode(node));
      if (sources.length === 0 || sources.every((source) => sameParent(source, currentTarget))) return;
      const mode = sources.every(({ root }) => samePath(root, currentTarget.root)) ? 'move' : 'copy';
      await this.actions.copyOrMove(sources, currentTarget, mode);
      return;
    }

    const uriItem = dataTransfer.get(URI_LIST_MIME);
    if (uriItem === undefined) return;
    const paths = await filePaths(uriItem);
    if (token.isCancellationRequested || paths.length === 0) return;
    await this.actions.copyExternal(paths, currentTarget);
  }
}

async function parseStableIds(item: vscode.DataTransferItem): Promise<readonly string[]> {
  try {
    const parsed: unknown = JSON.parse(await item.asString());
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : [];
  } catch {
    return [];
  }
}

async function filePaths(item: vscode.DataTransferItem): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const line of (await item.asString()).split(/\r?\n/u)) {
    const value = line.trim();
    if (value === '' || value.startsWith('#')) continue;
    try {
      const uri = vscode.Uri.parse(value);
      if (uri.scheme === 'file' && uri.fsPath.trim() !== '' && isAbsolute(uri.fsPath)) {
        paths.push(resolve(uri.fsPath));
      }
    } catch {
      // Ignore malformed or unsupported external drag entries.
    }
  }
  return [...new Set(paths)];
}

function isCurrentDragNode(node: MyCodeFileActionNode): node is MyCodeNode {
  return node.kind !== 'past' && node.kind !== 'history' && node.kind !== 'group';
}

function sameParent(source: MyCodeNode, target: MyCodeNode): boolean {
  return samePath(dirname(nodeAbsolutePath(source)), dropDestinationPath(target));
}

function dropDestinationPath(node: MyCodeNode): string {
  return node.kind === 'file' ? dirname(nodeAbsolutePath(node)) : nodeAbsolutePath(node);
}

function nodeAbsolutePath(node: MyCodeNode): string {
  switch (node.kind) {
    case 'file':
      return resolve(join(node.root, node.file.relativePath));
    case 'folder':
      return resolve(join(node.root, node.relativePath));
    case 'repository':
    case 'group':
      return resolve(node.root);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}
