import { dirname, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
import type { FileTreeNode, FolderTreeNode, PastActivityNode, RepositoryTreeNode } from '../../src/ui/myCodeTree.js';

const ROOT = resolve('workspace');
const OTHER_ROOT = resolve('other-workspace');

describe('MyCodeFileActions target normalization', () => {
  it('uses the selection only when the clicked node belongs to it', () => {
    const first = fileNode('src/first.ts');
    const second = fileNode('src/second.ts');
    const outside = fileNode('outside.ts');
    const selection = [first, second];
    const actions = actionHarness({ selection }).actions;

    expect(actions.targets(first)).toEqual(selection);
    expect(actions.targets(outside)).toEqual([outside]);
  });

  it('removes duplicate nodes and descendants covered by a selected ancestor', () => {
    const src = folderNode('src');
    const nested = fileNode('src/nested/child.ts');
    const sibling = fileNode('sibling.ts');
    const duplicateNested = { ...nested };
    const actions = actionHarness({ selection: [nested, sibling, src, duplicateNested] }).actions;

    expect(actions.targets(nested).map(({ id }) => id)).toEqual([sibling.id, src.id]);
  });
});

describe('MyCodeFileActions validation', () => {
  it('rejects traversal outside a registered repository immediately before mutation', async () => {
    const boundary = fakeBoundary([[ROOT, 'directory']]);
    boundary.names.push('../escape');
    const { actions } = actionHarness({ boundary });

    await actions.newFolder(repositoryNode());

    expect(boundary.createdDirectories).toEqual([]);
    expect(boundary.warnings).toEqual(['Enter a single name without path separators.']);
  });

  it('rejects a node whose resolved path escapes its declared registered root', async () => {
    const escaped = folderNode('../outside');
    const boundary = fakeBoundary();
    const { actions } = actionHarness({ boundary });

    await actions.delete(escaped);

    expect(boundary.deletedDirectories).toEqual([]);
    expect(boundary.confirmations).toEqual([]);
    expect(boundary.warnings).toEqual(['The selected path is outside a registered repository.']);
  });

  it('keeps past and missing file rows immutable', async () => {
    const boundary = fakeBoundary();
    const { actions } = actionHarness({ boundary });

    await actions.delete(pastNode('removed.ts'));
    await actions.rename(fileNode('missing.ts', false));

    expect(boundary.deletedFiles).toEqual([]);
    expect(boundary.renames).toEqual([]);
    expect(boundary.warnings).toEqual([
      'Past activity is read-only.',
      'Missing paths cannot be changed from My Code.'
    ]);
  });

  it('resolves paste destinations from folders, repository roots, and file parents', async () => {
    const source = fileNode('source.ts');
    const boundary = fakeBoundary([
      [ROOT, 'directory'],
      [join(ROOT, 'src'), 'directory'],
      [join(ROOT, 'source.ts'), 'file'],
      [join(ROOT, 'folder'), 'directory'],
      [join(ROOT, 'src', 'target.ts'), 'file']
    ]);
    const { actions } = actionHarness({ boundary });
    await actions.copy(source);

    await actions.paste(folderNode('folder'));
    await actions.paste(repositoryNode());
    await actions.paste(fileNode('src/target.ts'));

    expect(boundary.copies.map(([, destination]) => destination)).toEqual([
      join(ROOT, 'folder', 'source.ts'),
      join(ROOT, 'src', 'source.ts')
    ]);
    expect(boundary.names).toEqual([]);
  });

  it('makes a same-parent cut/paste a no-op and clears the completed cut', async () => {
    const source = fileNode('src/source.ts');
    const boundary = fakeBoundary([[join(ROOT, 'src', 'source.ts'), 'file']]);
    const { actions } = actionHarness({ boundary });

    await actions.cut(source);
    await actions.paste(source);
    await actions.paste(folderNode('elsewhere'));

    expect(boundary.renames).toEqual([]);
  });

  it('rejects copying or moving a folder into itself or a descendant', async () => {
    const source = folderNode('src');
    const child = folderNode('src/nested');
    const boundary = fakeBoundary([
      [join(ROOT, 'src'), 'directory'],
      [join(ROOT, 'src', 'nested'), 'directory']
    ]);
    const { actions } = actionHarness({ boundary });

    await actions.copyOrMove([source], source, 'copy');
    await actions.copyOrMove([source], child, 'move');

    expect(boundary.copies).toEqual([]);
    expect(boundary.renames).toEqual([]);
    expect(boundary.warnings).toEqual([
      'A folder cannot be copied into itself or one of its descendants.',
      'A folder cannot be moved into itself or one of its descendants.'
    ]);
  });

  it('rejects a cut move across registered roots while allowing an explicit copy', async () => {
    const source = fileNode('source.ts');
    const destination = repositoryNode(OTHER_ROOT);
    const boundary = fakeBoundary([
      [join(ROOT, 'source.ts'), 'file'],
      [OTHER_ROOT, 'directory']
    ]);
    const { actions } = actionHarness({ boundary, roots: [ROOT, OTHER_ROOT] });

    await actions.copyOrMove([source], destination, 'move');
    await actions.copyOrMove([source], destination, 'copy');

    expect(boundary.renames).toEqual([]);
    expect(boundary.copies).toEqual([[join(ROOT, 'source.ts'), join(OTHER_ROOT, 'source.ts')]]);
    expect(boundary.warnings).toEqual(['Cut items cannot be moved to another repository. Use Copy instead.']);
  });

  it('rejects blank roots and outer-root aliases owned by a nested registered root', async () => {
    const nestedRoot = join(ROOT, 'nested');
    const boundary = fakeBoundary([
      [join(nestedRoot, 'owned.ts'), 'file']
    ]);
    const { actions } = actionHarness({ boundary, roots: [ROOT, nestedRoot] });

    await actions.delete(fileNode('owned.ts', true, ''));
    await actions.delete(fileNode('nested/owned.ts', true, ROOT));

    expect(boundary.deletedFiles).toEqual([]);
    expect(boundary.confirmations).toEqual([]);
    expect(boundary.warnings).toEqual([
      'Repository roots cannot be empty.',
      'The selected path belongs to a more specific registered repository.'
    ]);
  });

  it('revalidates repository ownership after a prompt and before creating a child', async () => {
    let roots: readonly string[] = [ROOT];
    const boundary = fakeBoundary([[ROOT, 'directory']]);
    boundary.promptName = async () => {
      roots = [];
      return 'child';
    };
    const { actions } = actionHarness({ boundary, rootProvider: () => roots });

    await actions.newFolder(repositoryNode());

    expect(boundary.createdDirectories).toEqual([]);
    expect(boundary.warnings).toEqual(['The selected path is outside a registered repository.']);
  });

  it('deduplicates normalized path aliases before deleting', async () => {
    const direct = fileNode('src/owned.ts');
    const alias = fileNode('src/../src/owned.ts');
    const boundary = fakeBoundary([[join(ROOT, 'src', 'owned.ts'), 'file']]);
    const { actions } = actionHarness({ selection: [direct, alias], boundary });

    await actions.delete(direct);

    expect(boundary.deletedFiles).toEqual([join(ROOT, 'src', 'owned.ts')]);
    expect(boundary.warnings).toEqual([]);
  });
});

describe('MyCodeFileActions confirmations and operation errors', () => {
  it('names every mixed delete target, emphasizes recursive folders, and cancels the whole set', async () => {
    const folder = folderNode('folder');
    const file = fileNode('file.ts');
    const boundary = fakeBoundary([
      [join(ROOT, 'folder'), 'directory'],
      [join(ROOT, 'file.ts'), 'file']
    ]);
    boundary.confirmResults.push(false);
    const { actions } = actionHarness({ selection: [folder, file], boundary });

    await actions.delete(folder);

    expect(boundary.confirmations[0]?.message).toContain(join(ROOT, 'folder'));
    expect(boundary.confirmations[0]?.message).toContain(join(ROOT, 'file.ts'));
    expect(boundary.confirmations[0]?.detail).toContain(`Recursively deletes: ${join(ROOT, 'folder')}`);
    expect(boundary.deletedDirectories).toEqual([]);
    expect(boundary.deletedFiles).toEqual([]);
  });

  it('deletes the complete mixed set after confirmation', async () => {
    const folder = folderNode('folder');
    const file = fileNode('file.ts');
    const boundary = fakeBoundary([
      [join(ROOT, 'folder'), 'directory'],
      [join(ROOT, 'file.ts'), 'file']
    ]);
    const { actions } = actionHarness({ selection: [folder, file], boundary });

    await actions.delete(folder);

    expect(boundary.deletedDirectories).toEqual([join(ROOT, 'folder')]);
    expect(boundary.deletedFiles).toEqual([join(ROOT, 'file.ts')]);
  });

  it('confirms hidden recursive content for clipboard paste and explicit folder copy', async () => {
    const source = folderNode('source');
    const destination = folderNode('destination');
    const boundary = fakeBoundary([
      [join(ROOT, 'source'), 'directory'],
      [join(ROOT, 'destination'), 'directory']
    ]);
    boundary.confirmResults.push(false, true);
    const { actions } = actionHarness({ boundary });

    await actions.copy(source);
    await actions.paste(destination);
    await actions.copyOrMove([source], destination, 'copy');

    expect(boundary.confirmations).toHaveLength(2);
    expect(boundary.confirmations[0]?.message).toContain('hidden files');
    expect(boundary.confirmations[1]?.message).toContain('hidden files');
    expect(boundary.copies).toEqual([[join(ROOT, 'source'), join(ROOT, 'destination', 'source')]]);
  });

  it('reports throwing stat, collision, name prompt, and confirmation boundaries exactly once per operation', async () => {
    const source = fileNode('source.ts');

    const statBoundary = fakeBoundary();
    statBoundary.kind = async () => { throw new Error('stat failed'); };
    const statHarness = actionHarness({ boundary: statBoundary });
    await expect(statHarness.actions.copy(source)).resolves.toBeUndefined();
    expect(statHarness.onError).toHaveBeenCalledTimes(1);
    expect(statBoundary.errors).toHaveLength(1);

    const collisionBoundary = fakeBoundary([
      [join(ROOT, 'source.ts'), 'file'],
      [join(ROOT, 'destination'), 'directory']
    ]);
    const normalKind = collisionBoundary.kind.bind(collisionBoundary);
    collisionBoundary.kind = async (path) => {
      if (resolve(path) === join(ROOT, 'destination', 'source.ts')) throw new Error('collision stat failed');
      return normalKind(path);
    };
    const collisionHarness = actionHarness({ boundary: collisionBoundary });
    await collisionHarness.actions.copy(source);
    await expect(collisionHarness.actions.paste(folderNode('destination'))).resolves.toBeUndefined();
    expect(collisionHarness.onError).toHaveBeenCalledTimes(1);
    expect(collisionBoundary.errors).toHaveLength(1);


    const promptBoundary = fakeBoundary([[ROOT, 'directory']]);
    promptBoundary.promptName = async () => { throw new Error('prompt failed'); };
    const promptHarness = actionHarness({ boundary: promptBoundary });
    await expect(promptHarness.actions.newFile(repositoryNode())).resolves.toBeUndefined();
    expect(promptHarness.onError).toHaveBeenCalledTimes(1);
    expect(promptBoundary.errors).toHaveLength(1);

    const confirmBoundary = fakeBoundary([[join(ROOT, 'source.ts'), 'file']]);
    confirmBoundary.confirm = async () => { throw new Error('confirm failed'); };
    const confirmHarness = actionHarness({ boundary: confirmBoundary });
    await expect(confirmHarness.actions.delete(source)).resolves.toBeUndefined();
    expect(confirmHarness.onError).toHaveBeenCalledTimes(1);
    expect(confirmBoundary.errors).toHaveLength(1);
  });
});

describe('MyCodeFileActions conflicts and clipboard state', () => {
  it('asks for a non-conflicting name and never overwrites the existing destination', async () => {
    const source = fileNode('source.ts');
    const destination = folderNode('dest');
    const boundary = fakeBoundary([
      [join(ROOT, 'source.ts'), 'file'],
      [join(ROOT, 'dest'), 'directory'],
      [join(ROOT, 'dest', 'source.ts'), 'file']
    ]);
    boundary.names.push('source-copy.ts');
    const { actions } = actionHarness({ boundary });

    await actions.copy(source);
    await actions.paste(destination);

    expect(boundary.copies).toEqual([[join(ROOT, 'source.ts'), join(ROOT, 'dest', 'source-copy.ts')]]);
    expect(boundary.namePrompts[0]).toMatchObject({ value: 'source.ts' });
  });

  it('cancels a conflicting paste silently without changing files', async () => {
    const source = fileNode('source.ts');
    const destination = folderNode('dest');
    const boundary = fakeBoundary([
      [join(ROOT, 'source.ts'), 'file'],
      [join(ROOT, 'dest'), 'directory'],
      [join(ROOT, 'dest', 'source.ts'), 'file']
    ]);
    boundary.names.push(undefined);
    const { actions } = actionHarness({ boundary });

    await actions.copy(source);
    await actions.paste(destination);

    expect(boundary.copies).toEqual([]);
    expect(boundary.warnings).toEqual([]);
    expect(boundary.errors).toEqual([]);
  });

  it('retains only failed cut entries after a partial move and reports one error notification', async () => {
    const first = fileNode('first.ts');
    const second = fileNode('second.ts');
    const destination = folderNode('dest');
    const boundary = fakeBoundary([
      [join(ROOT, 'first.ts'), 'file'],
      [join(ROOT, 'second.ts'), 'file'],
      [join(ROOT, 'dest'), 'directory']
    ]);
    boundary.failRenameOnce.add(join(ROOT, 'second.ts'));
    const { actions, onError } = actionHarness({ selection: [first, second], boundary });

    await actions.cut(first);
    await actions.paste(destination);
    await actions.paste(destination);

    expect(boundary.renames).toEqual([
      [join(ROOT, 'first.ts'), join(ROOT, 'dest', 'first.ts')],
      [join(ROOT, 'second.ts'), join(ROOT, 'dest', 'second.ts')],
      [join(ROOT, 'second.ts'), join(ROOT, 'dest', 'second.ts')]
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'move', join(ROOT, 'second.ts'));
    expect(boundary.errors).toEqual(['Could not move 1 item. See My Code output for details.']);
  });
});

describe('MyCodeFileActions commands and prompts', () => {
  it('delegates open/reveal commands and textual paths through the injected boundary', async () => {
    const current = fileNode('src/current.ts');
    const folder = folderNode('src');
    const repository = repositoryNode();
    const historical = pastNode('src/removed.ts');
    const boundary = fakeBoundary([
      [join(ROOT, 'src', 'current.ts'), 'file'],
      [join(ROOT, 'src'), 'directory'],
      [ROOT, 'directory']
    ]);
    const { actions } = actionHarness({ boundary });

    await actions.open(current);
    await actions.openToSide(current);
    await actions.revealInExplorer(folder);
    await actions.revealInOs(repository);
    await actions.copyPath(historical);
    await actions.copyRelativePath(historical);

    expect(boundary.commands).toEqual([
      ['vscode.open', join(ROOT, 'src', 'current.ts')],
      ['vscode.open', join(ROOT, 'src', 'current.ts'), 'beside'],
      ['revealInExplorer', join(ROOT, 'src')],
      ['revealFileInOS', ROOT]
    ]);
    expect(boundary.clipboard).toEqual([
      join(ROOT, 'src', 'removed.ts'),
      join('src', 'removed.ts')
    ]);
  });

  it('warns before folder rename and validates the new name before applying it', async () => {
    const folder = folderNode('src');
    const boundary = fakeBoundary([[ROOT, 'directory'], [join(ROOT, 'src'), 'directory']]);
    boundary.confirmResults.push(true);
    boundary.names.push('renamed');
    const { actions } = actionHarness({ boundary });

    await actions.rename(folder);

    expect(boundary.confirmations[0]?.message).toContain('hidden files');
    expect(boundary.renames).toEqual([[join(ROOT, 'src'), join(ROOT, 'renamed')]]);
  });

  it('uses stronger explicit confirmation for recursive folder delete and keeps cancellation silent', async () => {
    const folder = folderNode('src');
    const boundary = fakeBoundary([[join(ROOT, 'src'), 'directory']]);
    boundary.confirmResults.push(false);
    const { actions } = actionHarness({ boundary });

    await actions.delete(folder);

    expect(boundary.confirmations[0]).toMatchObject({ confirmLabel: 'Delete Folder Recursively' });
    expect(boundary.confirmations[0]?.message).toContain(join(ROOT, 'src'));
    expect(boundary.deletedDirectories).toEqual([]);
    expect(boundary.warnings).toEqual([]);
    expect(boundary.errors).toEqual([]);
  });
});

interface FakeBoundary extends MyCodeFileActionBoundary {
  readonly names: Array<string | undefined>;
  readonly confirmResults: boolean[];
  readonly namePrompts: NamePrompt[];
  readonly confirmations: ConfirmationPrompt[];
  readonly commands: unknown[][];
  readonly clipboard: string[];
  readonly warnings: string[];
  readonly errors: string[];
  readonly createdFiles: string[];
  readonly createdDirectories: string[];
  readonly copies: Array<[string, string]>;
  readonly renames: Array<[string, string]>;
  readonly deletedFiles: string[];
  readonly deletedDirectories: string[];
  readonly failRenameOnce: Set<string>;
  realPath(path: string): Promise<string | undefined>;
  isSymbolicLink(path: string): Promise<boolean>;
}

function fakeBoundary(initial: ReadonlyArray<readonly [string, FileActionKind]> = []): FakeBoundary {
  const entries = new Map(initial.map(([path, kind]) => [resolve(path), kind]));
  const names: Array<string | undefined> = [];
  const confirmResults: boolean[] = [];
  const namePrompts: NamePrompt[] = [];
  const confirmations: ConfirmationPrompt[] = [];
  const commands: unknown[][] = [];
  const clipboard: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  const copies: Array<[string, string]> = [];
  const renames: Array<[string, string]> = [];
  const deletedFiles: string[] = [];
  const deletedDirectories: string[] = [];
  const failRenameOnce = new Set<string>();
  return {
    names,
    confirmResults,
    namePrompts,
    confirmations,
    commands,
    clipboard,
    warnings,
    errors,
    createdFiles,
    createdDirectories,
    copies,
    renames,
    deletedFiles,
    deletedDirectories,
    failRenameOnce,
    async executeCommand(command, path, ...args) {
      commands.push([command, path, ...args]);
    },
    async writeClipboard(value) {
      clipboard.push(value);
    },
    async promptName(prompt) {
      namePrompts.push(prompt);
      return names.shift();
    },
    async confirm(prompt) {
      confirmations.push(prompt);
      return confirmResults.shift() ?? true;
    },
    async warn(message) {
      warnings.push(message);
    },
    async showError(message) {
      errors.push(message);
    },
    async kind(path) {
      return entries.get(resolve(path));
    },
    async realPath(path) {
      return resolve(path);
    },
    async isSymbolicLink() {
      return false;
    },
    async createFile(path) {
      const normalized = resolve(path);
      createdFiles.push(normalized);
      entries.set(normalized, 'file');
    },
    async rename(source, destination) {
      const normalizedSource = resolve(source);
      const normalizedDestination = resolve(destination);
      renames.push([normalizedSource, normalizedDestination]);
      if (failRenameOnce.delete(normalizedSource)) throw new Error('move failed');
      const kind = entries.get(normalizedSource);
      entries.delete(normalizedSource);
      if (kind !== undefined) entries.set(normalizedDestination, kind);
    },
    async deleteFile(path) {
      const normalized = resolve(path);
      deletedFiles.push(normalized);
      entries.delete(normalized);
    },
    async createDirectory(path) {
      const normalized = resolve(path);
      createdDirectories.push(normalized);
      entries.set(normalized, 'directory');
    },
    async copy(source, destination) {
      const normalizedSource = resolve(source);
      const normalizedDestination = resolve(destination);
      copies.push([normalizedSource, normalizedDestination]);
      const kind = entries.get(normalizedSource);
      if (kind !== undefined) entries.set(normalizedDestination, kind);
    },
    async deleteDirectory(path) {
      const normalized = resolve(path);
      deletedDirectories.push(normalized);
      entries.delete(normalized);
    }
  };
}

function actionHarness(options: {
  selection?: readonly MyCodeFileActionNode[];
  boundary?: FakeBoundary;
  roots?: readonly string[];
  rootProvider?: () => readonly string[];
} = {}) {
  const boundary = options.boundary ?? fakeBoundary();
  const onError = vi.fn();
  const refresh = vi.fn();
  const actions = new MyCodeFileActions({
    selection: () => options.selection ?? [],
    roots: options.rootProvider ?? (() => options.roots ?? [ROOT]),
    refresh,
    onError,
    boundary
  });
  return { actions, boundary, onError, refresh };
}

function repositoryNode(root = ROOT): RepositoryTreeNode {
  return { id: `repository|${root}`, kind: 'repository', root, label: 'repo', children: [] };
}

function folderNode(relativePath: string, root = ROOT): FolderTreeNode {
  return {
    id: `folder|${root}|${relativePath}`,
    kind: 'folder',
    root,
    relativePath,
    label: relativePath === '' ? 'repo' : relativePath,
    children: []
  };
}

function fileNode(relativePath: string, exists = true, root = ROOT): FileTreeNode {
  return {
    id: `file|${root}|${relativePath}`,
    kind: 'file',
    root,
    file: fileRecord(relativePath, exists),
    label: relativePath,
    children: []
  };
}

function pastNode(relativePath: string): PastActivityNode {
  return {
    id: `past|${ROOT}|${relativePath}`,
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

function fileRecord(relativePath: string, exists: boolean): FileRecord {
  return { relativePath, kind: exists ? 'modified' : 'past', exists, working: false, binary: false, ranges: [], history: [] };
}
