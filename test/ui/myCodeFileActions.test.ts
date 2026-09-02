import { dirname, join, resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const translate = vi.hoisted(() => vi.fn((message: string) => message));
vi.mock('vscode', () => ({ env: { language: 'en' }, l10n: { t: translate } }));

beforeEach(() => translate.mockImplementation((message: string) => message));

import {
  MyCodeFileActions,
  type FileActionKind,
  type MyCodeFileActionBoundary,
  type MyCodeFileActionNode,
  type NamePrompt,
  type ConfirmationPrompt
} from '../../src/ui/myCodeFileActions.js';
import type { FileRecord } from '../../src/core/model.js';
import {
  myCodeNodeId,
  type FileTreeNode,
  type FolderTreeNode,
  type PastActivityNode,
  type RepositoryTreeNode
} from '../../src/ui/myCodeTree.js';

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

  it.each([
    ['past before current', true],
    ['current before past', false]
  ] as const)('does not expand a clicked past row into its mutable alias when selected %s', async (_order, pastFirst) => {
    const past = pastNode('shared.ts');
    const current = fileNode('shared.ts');
    const boundary = fakeBoundary([[join(ROOT, 'shared.ts'), 'file']]);
    const selection = pastFirst ? [past, current] : [current, past];
    const { actions } = actionHarness({ selection, boundary });

    expect(actions.targets(past)).toEqual([past]);

    await actions.delete(past);

    expect(boundary.deletedFiles).toEqual([]);
    expect(boundary.warnings).toEqual(['Past activity is read-only.']);
  });
});

describe('MyCodeFileActions editor opening', () => {
  it('opens one click as preview and the second same-file click as pinned', async () => {
    let now = 1_000;
    const current = fileNode('src/current.ts');
    const boundary = fakeBoundary([[join(ROOT, 'src/current.ts'), 'file']]);
    const { actions } = actionHarness({ selection: [current], boundary, now: () => now });

    await actions.open(current);
    now = 1_200;
    await actions.open(current);

    expect(boundary.commands).toEqual([
      ['vscode.open', join(ROOT, 'src/current.ts'), { preview: true }],
      ['vscode.open', join(ROOT, 'src/current.ts'), { preview: false }]
    ]);
  });
});

describe('MyCodeFileActions localization', () => {
  it('localizes immutable-history warnings through VS Code l10n', async () => {
    translate.mockImplementation((message: string) => message === 'Past activity is read-only.'
      ? '과거 활동은 읽기 전용입니다.'
      : message);
    const boundary = fakeBoundary([[join(ROOT, 'shared.ts'), 'file']]);
    const { actions } = actionHarness({ boundary });

    await actions.delete(pastNode('shared.ts'));

    expect(boundary.warnings).toEqual(['과거 활동은 읽기 전용입니다.']);
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
      'Missing paths cannot be changed from What Did I Write?.'
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

  it.each([
    ['past before current', true],
    ['current before past', false]
  ] as const)('rejects explicit copy sources containing immutable and current aliases when ordered %s', async (_order, pastFirst) => {
    const past = pastNode('shared.ts');
    const current = fileNode('shared.ts');
    const destination = folderNode('destination');
    const boundary = fakeBoundary([
      [join(ROOT, 'shared.ts'), 'file'],
      [join(ROOT, 'destination'), 'directory']
    ]);
    const sources = pastFirst ? [past, current] : [current, past];
    const { actions } = actionHarness({ boundary });

    await actions.copyOrMove(sources, destination, 'copy');

    expect(boundary.copies).toEqual([]);
    expect(boundary.warnings).toEqual(['Past activity is read-only.']);
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


  it('copies an external source only after resolving a non-conflicting destination name', async () => {
    const external = resolve(ROOT, '..', 'outside', 'asset.txt');
    const destination = folderNode('dest');
    const boundary = fakeBoundary([
      [external, 'file'],
      [join(ROOT, 'dest'), 'directory'],
      [join(ROOT, 'dest', 'asset.txt'), 'file']
    ]);
    boundary.names.push('asset-copy.txt');
    const { actions, refresh } = actionHarness({ boundary });

    await actions.copyExternal([external], destination);

    expect(boundary.copies).toEqual([[external, join(ROOT, 'dest', 'asset-copy.txt')]]);
    expect(boundary.copies).not.toContainEqual([external, join(ROOT, 'dest', 'asset.txt')]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('rejects empty and relative external paths before normalization', async () => {
    const destination = folderNode('dest');
    const boundary = fakeBoundary([[join(ROOT, 'dest'), 'directory']]);
    const { actions } = actionHarness({ boundary });

    await actions.copyExternal(['', 'relative/asset.txt'], destination);

    expect(boundary.copies).toEqual([]);
    expect(boundary.warnings).toEqual([
      'External drag paths must be absolute and cannot use symbolic links or junctions.'
    ]);
  });

  it('rejects an external source whose kind changes before the write', async () => {
    const source = resolve(ROOT, '..', 'outside', 'asset.txt');
    const destination = folderNode('dest');
    const boundary = fakeBoundary([
      [source, 'file'],
      [join(ROOT, 'dest'), 'directory']
    ]);
    const originalKind = boundary.kind.bind(boundary);
    let sourceReads = 0;
    boundary.kind = async (path) => sameTestPath(path, source)
      ? (++sourceReads === 1 ? 'file' : 'directory')
      : originalKind(path);
    const { actions } = actionHarness({ boundary });

    await actions.copyExternal([source], destination);

    expect(boundary.copies).toEqual([]);
    expect(boundary.confirmations).toEqual([]);
    expect(boundary.warnings).toContain('The external source changed before it could be copied.');
  });

  it('rejects an external source that becomes a symbolic link before the write', async () => {
    const source = resolve(ROOT, '..', 'outside', 'asset.txt');
    const destination = folderNode('dest');
    const boundary = fakeBoundary([
      [source, 'file'],
      [join(ROOT, 'dest'), 'directory']
    ]);
    let sourceChecks = 0;
    boundary.isSymbolicLink = async (path) =>
      sameTestPath(path, source) && ++sourceChecks > 1;
    const { actions } = actionHarness({ boundary });

    await actions.copyExternal([source], destination);

    expect(boundary.copies).toEqual([]);
    expect(boundary.warnings).toContain(
      'External drag paths cannot use symbolic links or junctions.'
    );
  });

  it('rejects an external source whose canonical identity changes before the write', async () => {
    const source = resolve(ROOT, '..', 'outside', 'asset.txt');
    const replacement = resolve(ROOT, '..', 'outside', 'replacement.txt');
    const destination = folderNode('dest');
    const boundary = fakeBoundary([
      [source, 'file'],
      [join(ROOT, 'dest'), 'directory']
    ]);
    const originalRealPath = boundary.realPath.bind(boundary);
    let sourceReads = 0;
    boundary.realPath = async (path) => sameTestPath(path, source)
      ? (++sourceReads === 1 ? source : replacement)
      : originalRealPath(path);
    const { actions } = actionHarness({ boundary });

    await actions.copyExternal([source], destination);

    expect(boundary.copies).toEqual([]);
    expect(boundary.warnings).toContain('The external source changed before it could be copied.');
  });

  it('rejects a destination whose canonical root and directory change before the write', async () => {
    const source = resolve(ROOT, '..', 'outside', 'asset.txt');
    const destinationPath = join(ROOT, 'dest');
    const shiftedRoot = join(ROOT, 'shifted-root');
    const boundary = fakeBoundary([
      [source, 'file'],
      [destinationPath, 'directory']
    ]);
    const originalRealPath = boundary.realPath.bind(boundary);
    let rootReads = 0;
    let destinationReads = 0;
    boundary.realPath = async (path) => {
      if (sameTestPath(path, ROOT)) return ++rootReads === 1 ? ROOT : shiftedRoot;
      if (sameTestPath(path, destinationPath)) {
        return ++destinationReads === 1 ? destinationPath : join(shiftedRoot, 'dest');
      }
      return originalRealPath(path);
    };
    const { actions } = actionHarness({ boundary });

    await actions.copyExternal([source], folderNode('dest'));

    expect(boundary.copies).toEqual([]);
    expect(boundary.warnings).toContain(
      'The destination changed before the external copy could be written.'
    );
  });

  it('rejects a late external-copy collision without overwriting it', async () => {
    const source = resolve(ROOT, '..', 'outside', 'asset.txt');
    const destinationPath = join(ROOT, 'dest');
    const target = join(destinationPath, 'asset.txt');
    const boundary = fakeBoundary([
      [source, 'file'],
      [destinationPath, 'directory']
    ]);
    const originalKind = boundary.kind.bind(boundary);
    let targetReads = 0;
    boundary.kind = async (path) => sameTestPath(path, target)
      ? (++targetReads === 1 ? undefined : 'file')
      : originalKind(path);
    const { actions } = actionHarness({ boundary });

    await actions.copyExternal([source], folderNode('dest'));

    expect(boundary.copies).toEqual([]);
    expect(boundary.warnings).toContain('The destination now exists: ' + target);
  });

  it('reports an unexpected external-copy failure exactly once', async () => {
    const source = resolve(ROOT, '..', 'outside', 'asset.txt');
    const destinationPath = join(ROOT, 'dest');
    const boundary = fakeBoundary([
      [source, 'file'],
      [destinationPath, 'directory']
    ]);
    const failure = new Error('copy failed');
    boundary.copy = async () => { throw failure; };
    const { actions, onError } = actionHarness({ boundary });

    await actions.copyExternal([source], folderNode('dest'));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure, 'external copy', source);
    expect(boundary.errors).toEqual([
      'Could not external copy 1 item. See What Did I Write? output for details.'
    ]);
  });

  it('rejects copying an external directory into one of its descendants', async () => {
    const source = join(ROOT, 'assets');
    const destination = folderNode('assets', ROOT);
    const boundary = fakeBoundary([[source, 'directory']]);
    const { actions, refresh } = actionHarness({ boundary });

    await actions.copyExternal([source], destination);

    expect(boundary.copies).toEqual([]);
    expect(boundary.warnings).toContain('A folder cannot be copied into itself or one of its descendants.');
    expect(refresh).not.toHaveBeenCalled();
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
    expect(boundary.errors).toEqual(['Could not move 1 item. See What Did I Write? output for details.']);
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
      ['vscode.open', join(ROOT, 'src', 'current.ts'), { preview: true }],
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

function sameTestPath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase();
}

function actionHarness(options: {
  selection?: readonly MyCodeFileActionNode[];
  boundary?: FakeBoundary;
  roots?: readonly string[];
  rootProvider?: () => readonly string[];
  now?: () => number;
} = {}) {
  const boundary = options.boundary ?? fakeBoundary();
  const onError = vi.fn();
  const refresh = vi.fn();
  const actionOptions = {
    selection: () => options.selection ?? [],
    roots: options.rootProvider ?? (() => options.roots ?? [ROOT]),
    refresh,
    onError,
    boundary,
    now: options.now
  };
  const actions = new MyCodeFileActions(actionOptions);
  return { actions, boundary, onError, refresh };
}

function repositoryNode(root = ROOT): RepositoryTreeNode {
  return { id: myCodeNodeId('repository', root), kind: 'repository', root, label: 'repo', children: [] };
}

function folderNode(relativePath: string, root = ROOT): FolderTreeNode {
  return {
    id: myCodeNodeId('folder', root, relativePath),
    kind: 'folder',
    root,
    relativePath,
    label: relativePath === '' ? 'repo' : relativePath,
    children: []
  };
}

function fileNode(relativePath: string, exists = true, root = ROOT): FileTreeNode {
  return {
    id: myCodeNodeId('file', root, relativePath),
    kind: 'file',
    root,
    file: fileRecord(relativePath, exists),
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

function fileRecord(relativePath: string, exists: boolean): FileRecord {
  return { relativePath, kind: exists ? 'modified' : 'past', exists, working: false, binary: false, ranges: [], history: [] };
}
