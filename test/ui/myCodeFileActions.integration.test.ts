import { cp, lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  MyCodeFileActions,
  type FileActionKind,
  type MyCodeFileActionBoundary,
  type MyCodeFileActionNode,
  type NamePrompt,
  type ConfirmationPrompt
} from '../../src/ui/myCodeFileActions.js';
import type { FileRecord } from '../../src/core/model.js';
import type { FileTreeNode, FolderTreeNode, RepositoryTreeNode } from '../../src/ui/myCodeTree.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MyCodeFileActions filesystem integration', () => {
  it('creates new files and folders inside a temporary repository', async () => {
    const root = await temporaryRepository();
    const boundary = diskBoundary();
    boundary.names.push('notes.txt', 'drafts');
    const { actions } = harness(root, boundary);

    await actions.newFile(repositoryNode(root));
    await actions.newFolder(repositoryNode(root));

    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('');
    expect(await pathKind(join(root, 'drafts'))).toBe('directory');
  });

  it('copies, cuts, pastes, and renames real files without overwriting', async () => {
    const root = await temporaryRepository();
    await mkdir(join(root, 'copies'));
    await mkdir(join(root, 'moved'));
    await writeFile(join(root, 'source.txt'), 'written by me');
    const boundary = diskBoundary();
    const { actions, setSelection } = harness(root, boundary);
    const source = fileNode(root, 'source.txt');

    await actions.copy(source);
    await actions.paste(folderNode(root, 'copies'));
    expect(await readFile(join(root, 'copies', 'source.txt'), 'utf8')).toBe('written by me');

    const copied = fileNode(root, 'copies/source.txt');
    setSelection([copied]);
    await actions.cut(copied);
    await actions.paste(folderNode(root, 'moved'));
    expect(await pathKind(join(root, 'copies', 'source.txt'))).toBeUndefined();
    expect(await readFile(join(root, 'moved', 'source.txt'), 'utf8')).toBe('written by me');

    boundary.names.push('renamed.txt');
    await actions.rename(fileNode(root, 'moved/source.txt'));
    expect(await pathKind(join(root, 'moved', 'source.txt'))).toBeUndefined();
    expect(await readFile(join(root, 'moved', 'renamed.txt'), 'utf8')).toBe('written by me');
  });

  it('recursively deletes the real folder including files filtered out of the tree', async () => {
    const root = await temporaryRepository();
    await mkdir(join(root, 'visible', 'nested'), { recursive: true });
    await writeFile(join(root, 'visible', 'tracked.ts'), 'shown');
    await writeFile(join(root, 'visible', 'nested', 'filtered.bin'), 'hidden');
    const boundary = diskBoundary();
    const { actions } = harness(root, boundary);

    await actions.delete(folderNode(root, 'visible'));

    expect(await pathKind(join(root, 'visible'))).toBeUndefined();
    expect(boundary.confirmations[0]).toMatchObject({ confirmLabel: 'Delete Folder Recursively' });
    expect(boundary.confirmations[0]?.message).toContain(join(root, 'visible'));
  });

  it('recursively copies real hidden content after an explicit folder warning', async () => {
    const root = await temporaryRepository();
    await mkdir(join(root, 'source', 'nested'), { recursive: true });
    await mkdir(join(root, 'destination'));
    await writeFile(join(root, 'source', 'visible.ts'), 'shown');
    await writeFile(join(root, 'source', 'nested', 'filtered.bin'), 'hidden');
    const boundary = diskBoundary();
    const { actions } = harness(root, boundary);

    await actions.copy(folderNode(root, 'source'));
    await actions.paste(folderNode(root, 'destination'));

    expect(await readFile(join(root, 'destination', 'source', 'nested', 'filtered.bin'), 'utf8')).toBe('hidden');
    expect(boundary.confirmations[0]?.message).toContain('hidden files');
  });

  it('rejects a mutable path that traverses a symlink or junction', async () => {
    const root = await temporaryRepository();
    const outside = await temporaryRepository();
    await writeFile(join(outside, 'secret.txt'), 'outside');
    try {
      await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return;
      throw error;
    }
    const boundary = diskBoundary();
    const { actions } = harness(root, boundary);

    await actions.delete(fileNode(root, 'link/secret.txt'));

    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
    expect(boundary.warnings).toContain('Paths through symbolic links or junctions cannot be changed from My Code.');
  });
});

interface DiskBoundary extends MyCodeFileActionBoundary {
  readonly names: Array<string | undefined>;
  readonly confirmations: ConfirmationPrompt[];
  readonly warnings: string[];
}

function diskBoundary(): DiskBoundary {
  const names: Array<string | undefined> = [];
  const confirmations: ConfirmationPrompt[] = [];
  const warnings: string[] = [];
  return {
    names,
    confirmations,
    warnings,
    async executeCommand() {},
    async writeClipboard() {},
    async promptName(prompt: NamePrompt) {
      void prompt;
      return names.shift();
    },
    async confirm(prompt) {
      confirmations.push(prompt);
      return true;
    },
    async warn(message) {
      warnings.push(message);
    },
    async showError() {},
    kind: pathKind,
    async realPath(path) {
      try {
        return await realpath(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async isSymbolicLink(path) {
      try {
        return (await lstat(path)).isSymbolicLink();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    async createFile(path) {
      await writeFile(path, '', { flag: 'wx' });
    },
    async rename(source, destination) {
      await rename(source, destination);
    },
    async deleteFile(path) {
      await unlink(path);
    },
    async createDirectory(path) {
      await mkdir(path);
    },
    async copy(source, destination) {
      await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    },
    async deleteDirectory(path) {
      await rm(path, { recursive: true });
    }
  };
}

function harness(root: string, boundary: DiskBoundary) {
  let selection: readonly MyCodeFileActionNode[] = [];
  const actions = new MyCodeFileActions({
    selection: () => selection,
    roots: () => [root],
    refresh: vi.fn(),
    onError: vi.fn(),
    boundary
  });
  return { actions, setSelection: (nodes: readonly MyCodeFileActionNode[]) => { selection = nodes; } };
}

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'my-code-file-actions-'));
  temporaryRoots.push(root);
  return root;
}

async function pathKind(path: string): Promise<FileActionKind | undefined> {
  try {
    const value = await stat(path);
    return value.isDirectory() ? 'directory' : 'file';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function repositoryNode(root: string): RepositoryTreeNode {
  return { id: `repository|${root}`, kind: 'repository', root, label: 'repo', children: [] };
}

function folderNode(root: string, relativePath: string): FolderTreeNode {
  return {
    id: `folder|${root}|${relativePath}`,
    kind: 'folder',
    root,
    relativePath,
    label: relativePath,
    children: []
  };
}

function fileNode(root: string, relativePath: string): FileTreeNode {
  return {
    id: `file|${root}|${relativePath}`,
    kind: 'file',
    root,
    file: fileRecord(relativePath),
    label: relativePath,
    children: []
  };
}

function fileRecord(relativePath: string): FileRecord {
  return { relativePath, kind: 'modified', exists: true, working: false, binary: false, ranges: [], history: [] };
}
