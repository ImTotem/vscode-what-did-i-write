import { dirname, join, resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  class DataTransferItem {
    public constructor(public readonly value: unknown) {}
    public async asString(): Promise<string> {
      return String(this.value);
    }
  }

  class DataTransfer {
    private readonly items = new Map<string, DataTransferItem>();

    public get(mimeType: string): DataTransferItem | undefined {
      return this.items.get(mimeType);
    }

    public set(mimeType: string, value: DataTransferItem): void {
      this.items.set(mimeType, value);
    }

    public forEach(callback: (item: DataTransferItem, mimeType: string) => void): void {
      this.items.forEach(callback);
    }
  }

  class Uri {
    public readonly scheme = 'file';

    private constructor(public readonly fsPath: string) {}

    public static file(path: string): Uri {
      return new Uri(resolve(path));
    }

    public static parse(value: string): Uri {
      if (value === 'file:' || value === 'file://') return new Uri('');
      if (value.startsWith('file:/relative')) return new Uri(decodeURIComponent(value.slice('file:/'.length)));
      if (!value.startsWith('file://')) throw new Error('unsupported URI');
      return new Uri(resolve(decodeURIComponent(value.slice('file://'.length))));
    }

    public toString(): string {
      return `file://${encodeURI(this.fsPath)}`;
    }
  }

  return { DataTransfer, DataTransferItem, Uri };
});

vi.mock('vscode', () => ({
  DataTransferItem: mocks.DataTransferItem,
  Uri: mocks.Uri
}));

import type { FileRecord } from '../../src/core/model.js';
import {
  MY_CODE_TREE_MIME,
  MyCodeDragAndDropController
} from '../../src/ui/myCodeDragAndDrop.js';
import {
  myCodeNodeId,
  type MyCodeNode,
  type FileTreeNode,
  type FolderTreeNode,
  type PastActivityNode,
  type RepositoryTreeNode
} from '../../src/ui/myCodeTree.js';

const ROOT = resolve('repo');
const OTHER_ROOT = resolve('other-repo');

describe('MyCodeDragAndDropController', () => {
  let provider: ReturnType<typeof providerFixture>;
  let actions: {
    copyOrMove: ReturnType<typeof vi.fn>;
    copyExternal: ReturnType<typeof vi.fn>;
  };
  let controller: MyCodeDragAndDropController;

  beforeEach(() => {
    provider = providerFixture();
    actions = {
      copyOrMove: vi.fn(async () => undefined),
      copyExternal: vi.fn(async () => undefined)
    };
    controller = new MyCodeDragAndDropController(provider, actions);
  });

  it('advertises the private tree payload and URI-list contracts', () => {
    expect(controller.dragMimeTypes).toEqual([MY_CODE_TREE_MIME, 'text/uri-list']);
    expect(controller.dropMimeTypes).toEqual([MY_CODE_TREE_MIME, 'text/uri-list']);
  });

  it('re-resolves every dragged stable id and moves a same-repository multi-selection', async () => {
    const staleA = fileNode('src/a.ts');
    const staleB = fileNode('src/b.ts');
    const staleTarget = folderNode('moved');
    const freshA = { ...staleA, label: 'fresh-a.ts' };
    const freshB = { ...staleB, label: 'fresh-b.ts' };
    const freshTarget = { ...staleTarget, label: 'fresh-moved' };
    const transfer = new mocks.DataTransfer();

    await controller.handleDrag([staleA, staleB], transfer as unknown as vscode.DataTransfer, token());
    provider.replace([freshA, freshB, freshTarget]);
    await controller.handleDrop(staleTarget, transfer as unknown as vscode.DataTransfer, token());

    expect(actions.copyOrMove).toHaveBeenCalledWith([freshA, freshB], freshTarget, 'move');
    expect(actions.copyExternal).not.toHaveBeenCalled();
  });

  it('copies rather than moves when any internal source crosses repository roots', async () => {
    const source = fileNode('src/a.ts', ROOT);
    const target = folderNode('received', OTHER_ROOT);
    const transfer = new mocks.DataTransfer();
    provider.replace([source, target]);

    await controller.handleDrag([source], transfer as unknown as vscode.DataTransfer, token());
    await controller.handleDrop(target, transfer as unknown as vscode.DataTransfer, token());

    expect(actions.copyOrMove).toHaveBeenCalledWith([source], target, 'copy');
  });

  it('does nothing when every internal source already has the drop target as its parent', async () => {
    const source = fileNode('src/a.ts');
    const target = folderNode('src');
    const transfer = new mocks.DataTransfer();
    provider.replace([source, target]);

    await controller.handleDrag([source], transfer as unknown as vscode.DataTransfer, token());
    await controller.handleDrop(target, transfer as unknown as vscode.DataTransfer, token());

    expect(actions.copyOrMove).not.toHaveBeenCalled();
  });

  it('supplies drag-out file URIs for all current sources', async () => {
    const sources = [fileNode('src/a.ts'), folderNode('assets')];
    const transfer = new mocks.DataTransfer();

    await controller.handleDrag(sources, transfer as unknown as vscode.DataTransfer, token());

    await expect(transfer.get('text/uri-list')?.asString()).resolves.toBe([
      mocks.Uri.file(join(ROOT, 'src/a.ts')).toString(),
      mocks.Uri.file(join(ROOT, 'assets')).toString()
    ].join('\r\n'));
  });

  it('copies external file URIs into a freshly resolved current destination', async () => {
    const staleTarget = folderNode('received');
    const freshTarget = { ...staleTarget, label: 'fresh-received' };
    const external = resolve('outside', 'asset.txt');
    const transfer = new mocks.DataTransfer();
    transfer.set('text/uri-list', new mocks.DataTransferItem([
      '# external editor comment',
      mocks.Uri.file(external).toString(),
      'https://example.test/not-a-file'
    ].join('\r\n')));
    provider.replace([freshTarget]);

    await controller.handleDrop(staleTarget, transfer as unknown as vscode.DataTransfer, token());

    expect(actions.copyExternal).toHaveBeenCalledWith([external], freshTarget);
    expect(actions.copyOrMove).not.toHaveBeenCalled();
  });

  it('rejects empty and relative file URI paths before normalizing them', async () => {
    const target = folderNode('received');
    const transfer = new mocks.DataTransfer();
    transfer.set('text/uri-list', new mocks.DataTransferItem([
      'file:',
      'file:/relative/asset.txt'
    ].join('\r\n')));
    provider.replace([target]);

    await controller.handleDrop(target, transfer as unknown as vscode.DataTransfer, token());

    expect(actions.copyExternal).not.toHaveBeenCalled();
  });

  it('keeps past rows immutable as both drag sources and drop targets', async () => {
    const past = pastNode('deleted.ts');
    const transfer = new mocks.DataTransfer();

    await controller.handleDrag([past], transfer as unknown as vscode.DataTransfer, token());
    transfer.set('text/uri-list', new mocks.DataTransferItem(mocks.Uri.file(resolve('outside.ts')).toString()));
    await controller.handleDrop(past, transfer as unknown as vscode.DataTransfer, token());

    expect(transfer.get(MY_CODE_TREE_MIME)).toBeUndefined();
    expect(actions.copyOrMove).not.toHaveBeenCalled();
    expect(actions.copyExternal).not.toHaveBeenCalled();
  });
});

function providerFixture() {
  const nodes = new Map<string, MyCodeNode>();
  return {
    resolveNode: (id: string) => nodes.get(id),
    replace: (replacement: readonly MyCodeNode[]) => {
      nodes.clear();
      for (const node of replacement) nodes.set(node.id, node);
    }
  };
}

function token(): vscode.CancellationToken {
  return { isCancellationRequested: false } as vscode.CancellationToken;
}

export function repositoryNode(root = ROOT): RepositoryTreeNode {
  return { id: myCodeNodeId('repository', root), kind: 'repository', root, label: 'repo', children: [] };
}

function folderNode(relativePath: string, root = ROOT): FolderTreeNode {
  return {
    id: myCodeNodeId('folder', root, relativePath),
    kind: 'folder',
    root,
    relativePath,
    label: relativePath,
    children: []
  };
}

function fileNode(relativePath: string, root = ROOT): FileTreeNode {
  return {
    id: myCodeNodeId('file', root, relativePath),
    kind: 'file',
    root,
    file: fileRecord(relativePath),
    label: relativePath,
    children: []
  };
}

function pastNode(relativePath: string): PastActivityNode {
  return {
    id: myCodeNodeId('past', ROOT, relativePath),
    kind: 'past',
    root: ROOT,
    relativePath,
    file: fileRecord(relativePath, false),
    label: relativePath,
    parentPath: dirname(relativePath),
    latestCommit: undefined,
    children: []
  };
}

function fileRecord(relativePath: string, exists = true): FileRecord {
  return {
    relativePath,
    kind: exists ? 'modified' : 'past',
    exists,
    working: false,
    binary: false,
    ranges: [],
    history: []
  };
}
