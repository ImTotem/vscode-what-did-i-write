import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

import * as vscode from 'vscode';

import { localize, type Localize } from '../localization.js';

import type {
  HistoryTreeNode,
  MyCodeNode,
  PastActivityNode
} from './myCodeTree.js';

export type MyCodeFileActionNode = MyCodeNode | HistoryTreeNode | PastActivityNode;
export type FileActionKind = 'file' | 'directory';
export type TransferMode = 'copy' | 'move';

export interface NamePrompt {
  readonly title: string;
  readonly prompt: string;
  readonly value?: string;
  readonly validateInput: (value: string) => Promise<string | undefined>;
}

export interface ConfirmationPrompt {
  readonly message: string;
  readonly detail?: string;
  readonly confirmLabel: string;
}

/** Narrow boundary so validation can be unit tested and disk effects can use temporary directories. */
export interface MyCodeFileActionBoundary {
  executeCommand(command: string, path: string, ...args: unknown[]): Promise<unknown>;
  writeClipboard(value: string): Promise<void>;
  promptName(prompt: NamePrompt): Promise<string | undefined>;
  confirm(prompt: ConfirmationPrompt): Promise<boolean>;
  warn(message: string): Promise<void>;
  showError(message: string): Promise<void>;
  kind(path: string): Promise<FileActionKind | undefined>;
  realPath(path: string): Promise<string | undefined>;
  isSymbolicLink(path: string): Promise<boolean>;
  createFile(path: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  deleteDirectory(path: string): Promise<void>;
}

export interface MyCodeFileActionsOptions {
  readonly selection: () => readonly MyCodeFileActionNode[];
  readonly roots: () => readonly string[];
  readonly refresh: () => void | Promise<void>;
  readonly onError: (error: unknown, operation: string, path: string) => void;
  readonly boundary?: MyCodeFileActionBoundary;
  readonly localize?: Localize;
  readonly now?: () => number;
}

interface ResolvedNode {
  readonly node: MyCodeFileActionNode;
  readonly path: string;
  readonly root: string;
  readonly canonicalPath: string;
  readonly canonicalRoot: string;
  readonly kind: FileActionKind;
}


interface ExternalSource {
  readonly path: string;
  readonly canonicalPath: string;
  readonly kind: FileActionKind;
}
interface TransferPlan extends ResolvedNode {
  readonly destination: string;
  readonly destinationIdentity: string;
  readonly noOp: boolean;
}

interface TransferResult {
  readonly completed: readonly MyCodeFileActionNode[];
  readonly failed: readonly MyCodeFileActionNode[];
  readonly cancelled: boolean;
}

interface FileClipboard {
  readonly mode: TransferMode;
  readonly nodes: readonly MyCodeFileActionNode[];
}

export class MyCodeFileActions {
  private readonly boundary: MyCodeFileActionBoundary;
  private readonly t: Localize;
  private clipboard: FileClipboard | undefined;
  private lastOpen: { readonly id: string; readonly at: number } | undefined;
  private readonly now: () => number;

  public constructor(private readonly options: MyCodeFileActionsOptions) {
    this.boundary = options.boundary ?? createVsCodeBoundary();
    this.t = options.localize ?? localize;
    this.now = options.now ?? Date.now;
  }

  public targets(clicked: MyCodeFileActionNode): readonly MyCodeFileActionNode[] {
    const selected = this.options.selection();
    const candidates = selected.some(({ id }) => id === clicked.id) ? selected : [clicked];
    const semanticCandidates = isImmutable(clicked)
      ? candidates.filter(isImmutable)
      : candidates;
    const unique = [...new Map(semanticCandidates.map((node) => [node.id, node])).values()];
    return unique.filter((candidate) => {
      const candidatePath = nodePath(candidate);
      if (candidatePath === undefined) return true;
      return !unique.some((possibleAncestor) => {
        if (possibleAncestor.id === candidate.id) return false;
        if (isImmutable(possibleAncestor) !== isImmutable(candidate)) return false;
        const ancestorPath = nodePath(possibleAncestor);
        return ancestorPath !== undefined
          && !samePath(ancestorPath, candidatePath)
          && pathContains(ancestorPath, candidatePath);
      });
    });
  }

  public async open(clicked: MyCodeFileActionNode): Promise<void> {
    const now = this.now();
    const pinned = this.lastOpen?.id === clicked.id
      && now >= this.lastOpen.at
      && now - this.lastOpen.at <= 500;
    this.lastOpen = pinned ? undefined : { id: clicked.id, at: now };
    await this.guard('open', clicked, () => this.runCommand(
      'open', clicked, true, 'vscode.open', { preview: !pinned }
    ));
  }

  public async openToSide(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('open to side', clicked, () => this.runCommand('open to side', clicked, true, 'vscode.open', 'beside'));
  }

  public async revealInExplorer(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('reveal in Explorer', clicked, () => this.runCommand('reveal in Explorer', clicked, false, 'revealInExplorer'));
  }

  public async revealInOs(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('reveal in operating system', clicked, () => this.runCommand('reveal in operating system', clicked, false, 'revealFileInOS'));
  }

  public async copyPath(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('copy path', clicked, () => this.copyPathImpl(clicked));
  }

  private async copyPathImpl(clicked: MyCodeFileActionNode): Promise<void> {
    const target = await this.resolveReadable(clicked, true);
    if (target === undefined) return;
    try {
      await this.boundary.writeClipboard(target.path);
    } catch (error) {
      await this.reportSingleFailure(error, 'copy path', target.path);
    }
  }

  public async copyRelativePath(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('copy relative path', clicked, () => this.copyRelativePathImpl(clicked));
  }

  private async copyRelativePathImpl(clicked: MyCodeFileActionNode): Promise<void> {
    const target = await this.resolveReadable(clicked, true);
    if (target === undefined) return;
    try {
      await this.boundary.writeClipboard(relative(target.root, target.path));
    } catch (error) {
      await this.reportSingleFailure(error, 'copy relative path', target.path);
    }
  }

  public async copy(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('copy', clicked, () => this.copyImpl(clicked));
  }

  private async copyImpl(clicked: MyCodeFileActionNode): Promise<void> {
    const nodes = this.targets(clicked);
    if (await this.resolveSources(nodes, 'copy') === undefined) return;
    this.clipboard = { mode: 'copy', nodes };
  }

  public async cut(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('cut', clicked, () => this.cutImpl(clicked));
  }

  private async cutImpl(clicked: MyCodeFileActionNode): Promise<void> {
    const nodes = this.targets(clicked);
    const sources = await this.resolveSources(nodes, 'cut');
    if (sources === undefined) return;
    if (sources.some(({ kind }) => kind === 'directory')) {
      const confirmed = await this.boundary.confirm({
        message: this.t('Cut this folder? It may contain hidden files not shown in What Did I Write?.'),
        detail: this.t('Pasting will move the entire real directory.'),
        confirmLabel: this.t('Cut Folder')
      });
      if (!confirmed) return;
    }
    this.clipboard = { mode: 'move', nodes };
  }

  public async paste(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guardTransfer('paste', clicked, () => this.pasteImpl(clicked));
  }

  private async pasteImpl(clicked: MyCodeFileActionNode): Promise<void> {
    const clipboard = this.clipboard;
    if (clipboard === undefined || clipboard.nodes.length === 0) return;
    const destination = await this.resolveDestination(clicked);
    if (destination === undefined) return;
    const result = await this.transfer(clipboard.nodes, destination, clipboard.mode, false);
    if (clipboard.mode === 'move' && !result.cancelled) {
      this.clipboard = result.failed.length === 0
        ? undefined
        : { mode: 'move', nodes: result.failed };
    }
  }

  /** File-action primitive used by Task 5 drag/drop; it does not implement drag/drop itself. */
  public async copyOrMove(
    sources: readonly MyCodeFileActionNode[],
    destination: MyCodeFileActionNode,
    mode: TransferMode
  ): Promise<void> {
    await this.guardTransfer(mode, destination, () => this.copyOrMoveImpl(sources, destination, mode));
  }

  private async copyOrMoveImpl(
    sources: readonly MyCodeFileActionNode[],
    destination: MyCodeFileActionNode,
    mode: TransferMode
  ): Promise<void> {
    const resolvedDestination = await this.resolveDestination(destination);
    if (resolvedDestination === undefined) return;
    await this.transfer(sources, resolvedDestination, mode, true);
  }

  public async copyExternal(
    paths: readonly string[],
    destination: MyCodeFileActionNode
  ): Promise<void> {
    await this.guardTransfer(
      'external copy',
      destination,
      () => this.copyExternalImpl(paths, destination)
    );
  }

  private async copyExternalImpl(
    paths: readonly string[],
    destinationNode: MyCodeFileActionNode
  ): Promise<void> {
    const destination = await this.resolveDestination(destinationNode);
    if (destination === undefined) return;
    const candidates: string[] = [];
    for (const path of new Set(paths)) {
      if (path.trim() === '' || !isAbsolute(path)) {
        await this.boundary.warn(this.t('External drag paths must be absolute and cannot use symbolic links or junctions.'));
        return;
      }
      candidates.push(resolve(path));
    }
    const sources: ExternalSource[] = [];
    for (const candidate of [...new Set(candidates)]) {
      if (await this.hasSymbolicLink(candidate)) {
        await this.boundary.warn(this.t('External drag paths must be absolute and cannot use symbolic links or junctions.'));
        return;
      }
      const canonicalPath = await this.boundary.realPath(candidate);
      const kind = await this.boundary.kind(candidate);
      if (canonicalPath === undefined || kind === undefined) {
        await this.boundary.warn(this.t('Missing external paths cannot be copied into What Did I Write?.'));
        return;
      }
      if (kind === 'directory' && pathContains(canonicalPath, destination.canonicalPath)) {
        await this.boundary.warn(this.t('A folder cannot be copied into itself or one of its descendants.'));
        return;
      }
      sources.push({ path: candidate, canonicalPath, kind });
    }
    if (sources.length === 0) return;
    if (sources.some(({ kind }) => kind === 'directory') && !await this.boundary.confirm({
      message: this.t('Copy this folder? It may contain hidden files not shown in What Did I Write?.'),
      detail: this.t('The entire real directory will be copied recursively.'),
      confirmLabel: this.t('Copy Folder Recursively')
    })) return;

    const planned = new Set<string>();
    const plans: Array<{ source: ExternalSource; name: string }> = [];
    for (const source of sources) {
      let name = basename(source.path);
      let target = resolve(destination.path, name);
      const identity = resolve(destination.canonicalPath, basename(source.canonicalPath));
      if (samePath(source.canonicalPath, identity)) continue;
      if (planned.has(pathKey(identity)) || await this.boundary.kind(target) !== undefined) {
        const replacement = await this.promptAvailableName(
          destination.path,
          name,
          'External Copy Conflict',
          planned
        );
        if (replacement === undefined) return;
        name = replacement;
        target = resolve(destination.path, name);
      }
      planned.add(pathKey(target));
      plans.push({ source, name });
    }

    let changed = false;
    let unexpectedFailures = 0;
    for (const plan of plans) {
      const currentDestination = await this.resolveDestination(destinationNode);
      if (currentDestination === undefined) continue;
      if (
        !samePath(currentDestination.root, destination.root)
        || !samePath(currentDestination.canonicalRoot, destination.canonicalRoot)
        || !samePath(currentDestination.canonicalPath, destination.canonicalPath)
      ) {
        await this.boundary.warn(this.t('The destination changed before the external copy could be written.'));
        continue;
      }
      if (await this.hasSymbolicLink(plan.source.path)) {
        await this.boundary.warn(this.t('External drag paths cannot use symbolic links or junctions.'));
        continue;
      }
      const currentCanonical = await this.boundary.realPath(plan.source.path);
      const currentKind = await this.boundary.kind(plan.source.path);
      if (currentCanonical === undefined || currentKind === undefined) {
        await this.boundary.warn(this.t('Missing external paths cannot be copied into What Did I Write?.'));
        continue;
      }
      if (currentKind !== plan.source.kind || !samePath(currentCanonical, plan.source.canonicalPath)) {
        await this.boundary.warn(this.t('The external source changed before it could be copied.'));
        continue;
      }
      if (currentKind === 'directory' && pathContains(currentCanonical, currentDestination.canonicalPath)) {
        await this.boundary.warn(this.t('A folder cannot be copied into itself or one of its descendants.'));
        continue;
      }
      const target = resolve(currentDestination.path, plan.name);
      const validatedDestination = await this.validateWriteDestination(currentDestination.root, target);
      if (validatedDestination === undefined || samePath(currentCanonical, validatedDestination.identity)) continue;
      if (await this.boundary.kind(validatedDestination.path) !== undefined) {
        await this.boundary.warn(this.t('The destination now exists: {path}', { path: validatedDestination.path }));
        continue;
      }
      try {
        await this.boundary.copy(plan.source.path, validatedDestination.path);
        changed = true;
      } catch (error) {
        unexpectedFailures += 1;
        this.options.onError(error, 'external copy', plan.source.path);
      }
    }
    if (changed) await this.refreshAfter('external copy', destination.path);
    await this.reportBatchFailures('external copy', unexpectedFailures);
  }

  public async rename(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('rename', clicked, () => this.renameImpl(clicked));
  }

  private async renameImpl(clicked: MyCodeFileActionNode): Promise<void> {
    if (!isFileOrFolder(clicked)) {
      await this.boundary.warn(this.t('Repository and group roots cannot be renamed.'));
      return;
    }
    const source = await this.resolveCurrent(clicked, 'rename');
    if (source === undefined) return;
    if (source.kind === 'directory') {
      const confirmed = await this.boundary.confirm({
        message: this.t('Rename this folder? It may contain hidden files not shown in What Did I Write?.'),
        detail: this.t('The entire real directory will be renamed.'),
        confirmLabel: this.t('Rename Folder')
      });
      if (!confirmed) return;
    }
    const name = await this.promptAvailableName(dirname(source.path), basename(source.path), 'Rename');
    if (name === undefined) return;
    const current = await this.resolveCurrent(clicked, 'rename');
    if (current === undefined) return;
    const destination = resolve(dirname(current.path), name);
    if (samePath(current.path, destination)) return;
    const validatedDestination = await this.validateWriteDestination(current.root, destination);
    if (validatedDestination === undefined) return;
    if (await this.boundary.kind(validatedDestination.path) !== undefined) {
      await this.boundary.warn(this.t('That name already exists.'));
      return;
    }
    try {
      await this.boundary.rename(current.path, validatedDestination.path);
      await this.refreshAfter('rename', current.path);
    } catch (error) {
      await this.reportSingleFailure(error, 'rename', current.path);
    }
  }

  public async delete(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('delete', clicked, () => this.deleteImpl(clicked));
  }

  private async deleteImpl(clicked: MyCodeFileActionNode): Promise<void> {
    const nodes = this.targets(clicked);
    const immutable = nodes.find(isImmutable);
    if (immutable !== undefined) {
      await this.boundary.warn(this.t(immutableMessage(immutable)));
      return;
    }
    if (nodes.some((node) => !isFileOrFolder(node))) {
      await this.boundary.warn(this.t('Repository and group roots cannot be deleted.'));
      return;
    }
    const resolved = await this.resolveSources(nodes, 'delete');
    if (resolved === undefined) return;
    const directories = resolved.filter(({ kind }) => kind === 'directory');
    const allPaths = resolved.map(({ path }) => path);
    const confirmed = await this.boundary.confirm({
      message: allPaths.length === 1
        ? this.t('Delete {path}?', { path: allPaths[0] ?? '' })
        : this.t('Delete {count} selected items?\n{paths}', {
          count: allPaths.length,
          paths: allPaths.join('\n')
        }),
      ...(directories.length === 0 ? {} : {
        detail: this.t('Recursively deletes: {paths}. Entire real folders are removed, including hidden files not shown in What Did I Write?.', {
          paths: directories.map(({ path }) => path).join(', ')
        })
      }),
      confirmLabel: this.t(directories.length === 0 ? 'Delete' : 'Delete Folder Recursively')
    });
    if (!confirmed) return;

    let successes = 0;
    const failures: Array<{ error: unknown; path: string }> = [];
    for (const item of resolved) {
      const current = await this.resolveCurrent(item.node, 'delete');
      if (current === undefined) continue;
      try {
        if (current.kind === 'directory') await this.boundary.deleteDirectory(current.path);
        else await this.boundary.deleteFile(current.path);
        successes += 1;
      } catch (error) {
        failures.push({ error, path: current.path });
        this.options.onError(error, 'delete', current.path);
      }
    }
    if (successes > 0) await this.refreshAfter('delete', resolved[0]?.path ?? '');
    await this.reportBatchFailures('delete', failures.length);
  }

  public async newFile(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('create file', clicked, () => this.createChild(clicked, 'file'));
  }

  public async newFolder(clicked: MyCodeFileActionNode): Promise<void> {
    await this.guard('create folder', clicked, () => this.createChild(clicked, 'directory'));
  }


  private async runCommand(
    operation: string,
    clicked: MyCodeFileActionNode,
    fileOnly: boolean,
    command: string,
    ...args: unknown[]
  ): Promise<void> {
    if (fileOnly && clicked.kind !== 'file' || isImmutable(clicked)) {
      await this.boundary.warn(this.t(fileOnly ? 'Only current files can be opened.' : 'Past activity cannot be revealed.'));
      return;
    }
    const target = await this.resolveCurrent(clicked, operation);
    if (target === undefined) return;
    try {
      await this.boundary.executeCommand(command, target.path, ...args);
    } catch (error) {
      await this.reportSingleFailure(error, operation, target.path);
    }
  }

  private async createChild(clicked: MyCodeFileActionNode, kind: FileActionKind): Promise<void> {
    const destination = await this.resolveDestination(clicked);
    if (destination === undefined) return;
    const title = kind === 'file' ? 'New File' : 'New Folder';
    const name = await this.promptAvailableName(destination.path, undefined, title);
    if (name === undefined) return;
    const currentDestination = await this.resolveDestination(clicked);
    if (currentDestination === undefined) return;
    const path = resolve(currentDestination.path, name);
    const validatedDestination = await this.validateWriteDestination(currentDestination.root, path);
    if (validatedDestination === undefined) return;
    if (await this.boundary.kind(validatedDestination.path) !== undefined) {
      await this.boundary.warn(this.t('That name already exists.'));
      return;
    }
    try {
      if (kind === 'file') await this.boundary.createFile(validatedDestination.path);
      else await this.boundary.createDirectory(validatedDestination.path);
      await this.refreshAfter(kind === 'file' ? 'create file' : 'create folder', validatedDestination.path);
    } catch (error) {
      await this.reportSingleFailure(error, kind === 'file' ? 'create file' : 'create folder', validatedDestination.path);
    }
  }

  private async transfer(
    nodes: readonly MyCodeFileActionNode[],
    destination: ResolvedNode,
    mode: TransferMode,
    warnForFolderMove: boolean
  ): Promise<TransferResult> {
    const sources = await this.resolveSources(nodes, mode);
    if (sources === undefined) return { completed: [], failed: nodes, cancelled: true };
    if (mode === 'move' && sources.some(({ root }) => !samePath(root, destination.root))) {
      await this.boundary.warn(this.t('Cut items cannot be moved to another repository. Use Copy instead.'));
      return { completed: [], failed: nodes, cancelled: true };
    }
    if (mode === 'move' && warnForFolderMove && sources.some(({ kind }) => kind === 'directory') && !await this.boundary.confirm({
      message: this.t('Move this folder? It may contain hidden files not shown in What Did I Write?.'),
      detail: this.t('The entire real directory will be moved.'),
      confirmLabel: this.t('Move Folder')
    })) return { completed: [], failed: nodes, cancelled: true };

    for (const source of sources) {
      if (source.kind === 'directory' && pathContains(source.canonicalPath, destination.canonicalPath)) {
        await this.boundary.warn(this.t(mode === 'copy'
          ? 'A folder cannot be copied into itself or one of its descendants.'
          : 'A folder cannot be moved into itself or one of its descendants.'));
        return { completed: [], failed: nodes, cancelled: true };
      }
    }
    if (mode === 'copy' && sources.some(({ kind }) => kind === 'directory') && !await this.boundary.confirm({
      message: this.t('Copy this folder? It may contain hidden files not shown in What Did I Write?.'),
      detail: this.t('The entire real directory will be copied recursively.'),
      confirmLabel: this.t('Copy Folder Recursively')
    })) return { completed: [], failed: nodes, cancelled: true };

    const plans = await this.planTransfers(sources, destination, mode);
    if (plans === undefined) return { completed: [], failed: nodes, cancelled: true };
    const completed: MyCodeFileActionNode[] = [];
    const failed: MyCodeFileActionNode[] = [];
    let changed = false;
    let unexpectedFailures = 0;
    for (const plan of plans) {
      const current = await this.resolveCurrent(plan.node, mode);
      const currentDestination = await this.resolveDestination(destination.node);
      if (current === undefined || currentDestination === undefined) {
        failed.push(plan.node);
        continue;
      }
      if (mode === 'move' && !samePath(current.root, currentDestination.root)) {
        await this.boundary.warn(this.t('Cut items cannot be moved to another repository. Use Copy instead.'));
        failed.push(plan.node);
        continue;
      }
      if (current.kind === 'directory' && pathContains(current.canonicalPath, currentDestination.canonicalPath)) {
        await this.boundary.warn(this.t(mode === 'copy'
          ? 'A folder cannot be copied into itself or one of its descendants.'
          : 'A folder cannot be moved into itself or one of its descendants.'));
        failed.push(plan.node);
        continue;
      }
      const target = resolve(currentDestination.path, basename(plan.destination));
      const validatedDestination = await this.validateWriteDestination(currentDestination.root, target);
      if (validatedDestination === undefined) {
        failed.push(plan.node);
        continue;
      }
      if (mode === 'move' && samePath(current.canonicalPath, validatedDestination.identity)) {
        completed.push(plan.node);
        continue;
      }
      if (await this.boundary.kind(validatedDestination.path) !== undefined) {
        await this.boundary.warn(this.t('The destination now exists: {path}', { path: validatedDestination.path }));
        failed.push(plan.node);
        continue;
      }
      try {
        if (mode === 'copy') await this.boundary.copy(current.path, validatedDestination.path);
        else await this.boundary.rename(current.path, validatedDestination.path);
        completed.push(plan.node);
        changed = true;
      } catch (error) {
        failed.push(plan.node);
        unexpectedFailures += 1;
        this.options.onError(error, mode, current.path);
      }
    }
    if (changed) await this.refreshAfter(mode, destination.path);
    await this.reportBatchFailures(mode, unexpectedFailures);
    return { completed, failed, cancelled: false };
  }

  private async planTransfers(
    sources: readonly ResolvedNode[],
    destination: ResolvedNode,
    mode: TransferMode
  ): Promise<readonly TransferPlan[] | undefined> {
    const planned = new Set<string>();
    const plans: TransferPlan[] = [];
    for (const source of sources) {
      let target = resolve(destination.path, basename(source.path));
      let targetIdentity = resolve(destination.canonicalPath, basename(source.canonicalPath));
      if (mode === 'move' && samePath(source.canonicalPath, targetIdentity)) {
        plans.push({ ...source, destination: target, destinationIdentity: targetIdentity, noOp: true });
        planned.add(pathKey(targetIdentity));
        continue;
      }
      if (planned.has(pathKey(targetIdentity)) || await this.boundary.kind(target) !== undefined) {
        const name = await this.promptAvailableName(
          destination.path,
          basename(source.path),
          mode === 'copy' ? 'Copy Conflict' : 'Move Conflict',
          planned
        );
        if (name === undefined) return undefined;
        target = resolve(destination.path, name);
        targetIdentity = resolve(destination.canonicalPath, name);
      }
      planned.add(pathKey(targetIdentity));
      plans.push({ ...source, destination: target, destinationIdentity: targetIdentity, noOp: false });
    }
    return plans;
  }

  private async promptAvailableName(
    parent: string,
    value: string | undefined,
    title: string,
    planned: ReadonlySet<string> = new Set()
  ): Promise<string | undefined> {
    const validateInput = async (candidate: string): Promise<string | undefined> => {
      const nameError = validateName(candidate);
      if (nameError !== undefined) return this.t(nameError);
      const path = resolve(parent, candidate);
      if (!pathContains(parent, path) || samePath(parent, path)) return this.t('Enter a single name without path separators.');
      if (planned.has(pathKey(path)) || await this.boundary.kind(path) !== undefined) return this.t('That name already exists.');
      return undefined;
    };
    const name = await this.boundary.promptName({
      title: this.t(title),
      prompt: this.t('Enter a non-conflicting name, or cancel.'),
      ...(value === undefined ? {} : { value }),
      validateInput
    });
    if (name === undefined) return undefined;
    const validation = await validateInput(name);
    if (validation !== undefined) {
      await this.boundary.warn(validation);
      return undefined;
    }
    return name;
  }

  private async resolveSources(
    nodes: readonly MyCodeFileActionNode[],
    operation: string
  ): Promise<readonly ResolvedNode[] | undefined> {
    const resolved: ResolvedNode[] = [];
    for (const node of nodes) {
      const source = await this.resolveCurrent(node, operation);
      if (source === undefined) return undefined;
      resolved.push(source);
    }
    const unique = [...new Map(resolved.map((source) => [pathKey(source.canonicalPath), source])).values()];
    return unique.filter((candidate) => !unique.some((ancestor) =>
      !samePath(ancestor.canonicalPath, candidate.canonicalPath)
      && pathContains(ancestor.canonicalPath, candidate.canonicalPath)));
  }

  private async resolveDestination(node: MyCodeFileActionNode): Promise<ResolvedNode | undefined> {
    const current = await this.resolveCurrent(node, 'paste destination');
    if (current === undefined) return undefined;
    if (node.kind === 'file') {
      return {
        node,
        root: current.root,
        path: dirname(current.path),
        canonicalPath: dirname(current.canonicalPath),
        canonicalRoot: current.canonicalRoot,
        kind: 'directory'
      };
    }
    if (current.kind !== 'directory') {
      await this.boundary.warn(this.t('Choose a folder, repository root, or file parent as the destination.'));
      return undefined;
    }
    return current;
  }

  private async resolveReadable(node: MyCodeFileActionNode, allowPast: boolean): Promise<ResolvedNode | undefined> {
    if (!allowPast && isImmutable(node)) {
      await this.boundary.warn(this.t(immutableMessage(node)));
      return undefined;
    }
    const lexical = await this.lexicalNode(node);
    if (lexical === undefined) return undefined;
    return {
      node,
      ...lexical,
      canonicalPath: lexical.path,
      canonicalRoot: lexical.root,
      kind: node.kind === 'folder' || node.kind === 'repository' || node.kind === 'group' ? 'directory' : 'file'
    };
  }

  private async resolveCurrent(node: MyCodeFileActionNode, operation: string): Promise<ResolvedNode | undefined> {
    if (isImmutable(node)) {
      await this.boundary.warn(this.t(immutableMessage(node)));
      return undefined;
    }
    const lexical = await this.lexicalNode(node);
    if (lexical === undefined) return undefined;
    try {
      const existing = await this.resolveExistingPath(lexical.root, lexical.path);
      return existing === undefined ? undefined : { node, ...existing };
    } catch (error) {
      await this.reportSingleFailure(error, operation, lexical.path);
      return undefined;
    }
  }

  private async lexicalNode(node: MyCodeFileActionNode): Promise<{ path: string; root: string } | undefined> {
    if (node.root.trim() === '') {
      await this.boundary.warn(this.t('Repository roots cannot be empty.'));
      return undefined;
    }
    const root = resolve(node.root);
    const path = nodePath(node);
    if (path === undefined) {
      await this.boundary.warn(this.t('Ambiguous empty paths cannot be changed from What Did I Write?.'));
      return undefined;
    }
    if (!await this.validateOwnership(root, path)) return undefined;
    return { root, path: resolve(path) };
  }

  private async validateOwnership(root: string, path: string): Promise<boolean> {
    const registeredRoots = this.options.roots()
      .filter((registered) => registered.trim() !== '')
      .map((registered) => resolve(registered));
    if (!registeredRoots.some((registered) => samePath(registered, root)) || !pathContains(root, path)) {
      await this.boundary.warn(this.t('The selected path is outside a registered repository.'));
      return false;
    }
    const owner = registeredRoots
      .filter((registered) => pathContains(registered, path))
      .sort((left, right) => right.length - left.length)[0];
    if (owner === undefined || !samePath(owner, root)) {
      await this.boundary.warn(this.t('The selected path belongs to a more specific registered repository.'));
      return false;
    }
    return true;
  }

  private async resolveExistingPath(
    root: string,
    path: string
  ): Promise<Omit<ResolvedNode, 'node'> | undefined> {
    if (!await this.validateOwnership(root, path)) return undefined;
    if (await this.hasSymbolicLink(path)) {
      await this.boundary.warn(this.t('Paths through symbolic links or junctions cannot be changed from What Did I Write?.'));
      return undefined;
    }
    const canonicalRoot = await this.boundary.realPath(root);
    const canonicalPath = await this.boundary.realPath(path);
    const kind = await this.boundary.kind(path);
    if (canonicalRoot === undefined || canonicalPath === undefined || kind === undefined) {
      await this.boundary.warn(this.t('Missing paths cannot be changed from What Did I Write?.'));
      return undefined;
    }
    if (!pathContains(canonicalRoot, canonicalPath)) {
      await this.boundary.warn(this.t('The selected path is outside a registered repository.'));
      return undefined;
    }
    return { root, path, canonicalRoot, canonicalPath, kind };
  }

  private async validateWriteDestination(
    root: string,
    destination: string
  ): Promise<{ path: string; identity: string } | undefined> {
    if (!await this.validateOwnership(root, destination)) return undefined;
    const parent = dirname(destination);
    const existingParent = await this.resolveExistingPath(root, parent);
    if (existingParent === undefined) return undefined;
    if (existingParent.kind !== 'directory') {
      await this.boundary.warn(this.t('The destination parent is not a directory.'));
      return undefined;
    }
    return {
      path: resolve(destination),
      identity: resolve(existingParent.canonicalPath, basename(destination))
    };
  }

  private async hasSymbolicLink(path: string): Promise<boolean> {
    for (const prefix of pathPrefixes(path)) {
      if (await this.boundary.isSymbolicLink(prefix)) return true;
    }
    return false;
  }

  private async guard(operation: string, node: MyCodeFileActionNode, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      await this.reportSingleFailure(error, operation, diagnosticPath(node));
    }
  }

  private async guardTransfer(
    operation: string,
    destination: MyCodeFileActionNode,
    action: () => Promise<void>
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      await this.reportSingleFailure(error, operation, diagnosticPath(destination));
    }
  }

  private async refreshAfter(operation: string, path: string): Promise<void> {
    try {
      await this.options.refresh();
    } catch (error) {
      await this.reportSingleFailure(error, `${operation} refresh`, path);
    }
  }

  private async reportSingleFailure(error: unknown, operation: string, path: string): Promise<void> {
    this.options.onError(error, operation, path);
    await this.boundary.showError(this.t(
      'Could not {operation} {path}. See What Did I Write? output for details.',
      { operation: this.operationLabel(operation), path }
    ));
  }

  private async reportBatchFailures(operation: string, count: number): Promise<void> {
    if (count === 0) return;
    await this.boundary.showError(this.t(
      count === 1
        ? 'Could not {operation} {count} item. See What Did I Write? output for details.'
        : 'Could not {operation} {count} items. See What Did I Write? output for details.',
      { operation: this.operationLabel(operation), count }
    ));
  }

  private operationLabel(operation: string): string {
    const suffix = ' refresh';
    return operation.endsWith(suffix)
      ? this.t('{operation} refresh', { operation: this.t(operation.slice(0, -suffix.length)) })
      : this.t(operation);
  }
}

function createVsCodeBoundary(): MyCodeFileActionBoundary {
  const apply = async (edit: vscode.WorkspaceEdit): Promise<void> => {
    if (!await vscode.workspace.applyEdit(edit)) throw new Error(localize('VS Code rejected the workspace edit.'));
  };
  return {
    async executeCommand(command, path, ...args) {
      const converted = args.map((argument) => argument === 'beside' ? vscode.ViewColumn.Beside : argument);
      return vscode.commands.executeCommand(command, vscode.Uri.file(path), ...converted);
    },
    async writeClipboard(value) {
      await vscode.env.clipboard.writeText(value);
    },
    async promptName(prompt) {
      return await vscode.window.showInputBox(prompt);
    },
    async confirm(prompt) {
      return await vscode.window.showWarningMessage(
        prompt.message,
        { modal: true, ...(prompt.detail === undefined ? {} : { detail: prompt.detail }) },
        prompt.confirmLabel
      ) === prompt.confirmLabel;
    },
    async warn(message) {
      await vscode.window.showWarningMessage(message);
    },
    async showError(message) {
      await vscode.window.showErrorMessage(message);
    },
    async kind(path) {
      try {
        const item = await vscode.workspace.fs.stat(vscode.Uri.file(path));
        return (item.type & vscode.FileType.Directory) !== 0 ? 'directory' : 'file';
      } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
      }
    },
    async realPath(path) {
      try {
        return await realpath(path);
      } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
      }
    },
    async isSymbolicLink(path) {
      try {
        return (await lstat(path)).isSymbolicLink();
      } catch (error) {
        if (isFileNotFound(error)) return false;
        throw error;
      }
    },
    async createFile(path) {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(vscode.Uri.file(path), { ignoreIfExists: false, overwrite: false });
      await apply(edit);
    },
    async rename(source, destination) {
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(vscode.Uri.file(source), vscode.Uri.file(destination), { ignoreIfExists: false, overwrite: false });
      await apply(edit);
    },
    async deleteFile(path) {
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(vscode.Uri.file(path), { ignoreIfNotExists: false, recursive: false });
      await apply(edit);
    },
    async createDirectory(path) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path));
    },
    async copy(source, destination) {
      await vscode.workspace.fs.copy(vscode.Uri.file(source), vscode.Uri.file(destination), { overwrite: false });
    },
    async deleteDirectory(path) {
      await vscode.workspace.fs.delete(vscode.Uri.file(path), { recursive: true, useTrash: true });
    }
  };
}

function nodePath(node: MyCodeFileActionNode): string | undefined {
  if (node.root.trim() === '') return undefined;
  switch (node.kind) {
    case 'repository':
    case 'group':
      return resolve(node.root);
    case 'folder':
      if (node.relativePath.trim() === '') return resolve(node.root);
      return resolve(node.root, node.relativePath);
    case 'file':
      if (node.file.relativePath.trim() === '') return undefined;
      return resolve(node.root, node.file.relativePath);
    case 'history':
    case 'past':
      if (node.relativePath.trim() === '') return undefined;
      return resolve(node.root, node.relativePath);
  }
}

function isImmutable(node: MyCodeFileActionNode): boolean {
  return node.kind === 'past'
    || node.kind === 'history'
    || node.kind === 'group' && node.group === 'past'
    || node.kind === 'folder' && node.group === 'past'
    || node.kind === 'file' && (!node.file.exists || node.file.kind === 'past');
}

function immutableMessage(node: MyCodeFileActionNode): string {
  return node.kind === 'file' && !node.file.exists
    ? 'Missing paths cannot be changed from What Did I Write?.'
    : 'Past activity is read-only.';
}

function isFileOrFolder(node: MyCodeFileActionNode): boolean {
  return node.kind === 'file' || node.kind === 'folder';
}

function validateName(value: string): string | undefined {
  const name = value.trim();
  if (name === '' || name === '.' || name === '..' || isAbsolute(name) || name.includes('/') || name.includes('\\') || name.includes(sep)) {
    return 'Enter a single name without path separators.';
  }
  return undefined;
}

function pathContains(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function diagnosticPath(node: MyCodeFileActionNode): string {
  if (node.root.trim() === '') return '<empty repository root>';
  return nodePath(node) ?? resolve(node.root);
}

function pathPrefixes(path: string): readonly string[] {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const prefixes: string[] = [];
  let current = root;
  prefixes.push(root);
  for (const segment of relative(root, normalized).split(sep).filter((part) => part !== '')) {
    current = resolve(current, segment);
    prefixes.push(current);
  }
  return prefixes;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && ((error as { code?: unknown }).code === 'FileNotFound' || (error as { code?: unknown }).code === 'ENOENT');
}
