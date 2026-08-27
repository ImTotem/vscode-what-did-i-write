import * as vscode from 'vscode';

import type { MyCodeDecorationProvider } from './fileDecorations.js';
import type { EditorOwnershipController } from './editorOwnership.js';
import type { MyCodeNode, MyCodeTreeProvider } from './myCodeTree.js';

type CurrentTree = Pick<MyCodeTreeProvider, 'expandableNodes' | 'getParent' | 'onDidChangeTreeData'>;

export class MyCodeViewController implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];
  private readonly expanded = new Set<string>();
  private contextWrite: Promise<void> | undefined;
  private expansionOperation = 0;
  private rebuildGeneration = 0;

  public constructor(
    private readonly provider: CurrentTree,
    private readonly view: vscode.TreeView<MyCodeNode>
  ) {
    this.subscriptions = [
      view.onDidExpandElement(({ element }) => this.recordExpanded(element)),
      view.onDidCollapseElement(({ element }) => this.recordCollapsed(element)),
      provider.onDidChangeTreeData(() => this.resetExpansionState())
    ];
    void Promise.resolve(this.setAllExpanded(false)).catch(() => undefined);
  }

  public async expandAll(): Promise<void> {
    const operation = ++this.expansionOperation;
    const rebuildGeneration = this.rebuildGeneration;
    const levels = expansionLevels(this.provider, this.provider.expandableNodes());
    try {
      for (const level of levels) {
        const revealed = await Promise.all(level.map(async (node) => {
          await this.view.reveal(node, { expand: true, select: false, focus: false });
          return node;
        }));
        if (!this.isCurrentExpansion(operation, rebuildGeneration)) return;
        for (const node of revealed) this.expanded.add(node.id);
      }
      if (!this.isCurrentExpansion(operation, rebuildGeneration)) return;
      await this.syncExpansionContext();
      if (!this.isCurrentExpansion(operation, rebuildGeneration)) return;
    } catch (error) {
      if (this.isCurrentExpansion(operation, rebuildGeneration)) {
        await this.syncExpansionContext().catch(() => undefined);
      }
      throw error;
    }
  }

  public async collapseAll(): Promise<void> {
    this.expansionOperation += 1;
    try {
      await vscode.commands.executeCommand('myCode.explorer.focus');
      await vscode.commands.executeCommand('list.collapseAll');
    } catch (error) {
      await this.syncExpansionContext().catch(() => undefined);
      throw error;
    }
    this.expanded.clear();
    await this.setAllExpanded(false);
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private recordExpanded(element: MyCodeNode): void {
    if (this.provider.expandableNodes().some((node) => node.id === element.id)) {
      this.expanded.add(element.id);
    }
    void this.syncExpansionContext().catch(() => undefined);
  }

  private recordCollapsed(element: MyCodeNode): void {
    this.expansionOperation += 1;
    for (const node of this.provider.expandableNodes()) {
      if (this.isInCollapsedSubtree(node, element)) this.expanded.delete(node.id);
    }
    void this.syncExpansionContext().catch(() => undefined);
  }

  private isInCollapsedSubtree(node: MyCodeNode, ancestor: MyCodeNode): boolean {
    let current: MyCodeNode | undefined = node;
    while (current !== undefined) {
      if (current.id === ancestor.id) return true;
      current = this.provider.getParent(current);
    }
    return false;
  }

  private isCurrentExpansion(operation: number, rebuildGeneration: number): boolean {
    return this.expansionOperation === operation && this.rebuildGeneration === rebuildGeneration;
  }

  private resetExpansionState(): void {
    this.expansionOperation += 1;
    this.rebuildGeneration += 1;
    this.expanded.clear();
    void Promise.resolve(this.setAllExpanded(false)).catch(() => undefined);
  }

  private syncExpansionContext(): Promise<void> {
    const nodes = this.provider.expandableNodes();
    const allExpanded = nodes.length > 0 && nodes.every((node) => this.expanded.has(node.id));
    return this.setAllExpanded(allExpanded);
  }

  private setAllExpanded(value: boolean): Promise<void> {
    const previous = this.contextWrite;
    const execute = (): Promise<void> => Promise.resolve(
      vscode.commands.executeCommand('setContext', 'myCode.treeAllExpanded', value)
    ).then(() => undefined);
    const write = previous === undefined
      ? execute()
      : previous.catch(() => undefined).then(execute);
    this.contextWrite = write;
    void write.then(
      () => { if (this.contextWrite === write) this.contextWrite = undefined; },
      () => { if (this.contextWrite === write) this.contextWrite = undefined; }
    );
    return write;
  }
}

function expansionLevels(provider: CurrentTree, nodes: readonly MyCodeNode[]): readonly (readonly MyCodeNode[])[] {
  const expandableIds = new Set(nodes.map(({ id }) => id));
  const levels: MyCodeNode[][] = [];
  for (const node of nodes) {
    let depth = 0;
    let current = node;
    const seen = new Set<string>([node.id]);
    while (true) {
      const parent = provider.getParent(current);
      if (parent === undefined || !expandableIds.has(parent.id) || seen.has(parent.id)) break;
      seen.add(parent.id);
      depth += 1;
      current = parent;
    }
    const level = levels[depth] ?? [];
    level.push(node);
    levels[depth] = level;
  }
  return levels;
}

interface ScmDecorationSnapshot {
  readonly hasWorkspaceValue: boolean;
  readonly value?: string;
}
type VisualState = Pick<vscode.Memento, 'get' | 'update'>;
const SCM_DECORATION_STATE = 'myCode.visuals.previousScmDiffDecorations';


export class VisualModeController {
  private enabled = true;
  private contextWrite: Promise<void> | undefined;
  private operation = 0;

  public constructor(
    private readonly decorations: Pick<MyCodeDecorationProvider, 'setEnabled'>,
    private readonly editors: Pick<EditorOwnershipController, 'setEnabled'>,
    private readonly state?: VisualState,
    private readonly quickDiff?: { setEnabled(enabled: boolean): void | Promise<void> }
  ) {
    void this.acceptInitialConfiguration();
  }

  public toggle(): Promise<void> {
    return this.setEnabled(!this.visualsEnabled());
  }

  public async setEnabled(next: boolean): Promise<void> {
    const operation = ++this.operation;
    const previous = this.enabled;
    const configuration = vscode.workspace.getConfiguration('myCode');
    try {
      await configuration.update('visuals.enabled', next, vscode.ConfigurationTarget.Workspace);
    } catch (error) {
      if (this.isCurrentOperation(operation)) await this.restore(previous, operation);
      throw error;
    }
    if (!this.isCurrentOperation(operation)) return;
    await this.applyOrRestore(next, previous, operation);
  }

  public async acceptConfigurationChange(): Promise<void> {
    const next = this.visualsEnabled();
    const operation = ++this.operation;
    const previous = this.enabled;
    await this.applyOrRestore(next, previous, operation);
  }

  public async shutdown(): Promise<void> {
    this.operation += 1;
    await this.quickDiff?.setEnabled(false);
    await this.restoreLegacyScmDecorations();
  }

  private async acceptInitialConfiguration(): Promise<void> {
    const next = this.visualsEnabled();
    const operation = ++this.operation;
    const previous = this.enabled;
    try {
      await this.restoreLegacyScmDecorations();
      if (!this.isCurrentOperation(operation)) return;
      await this.apply(next, operation);
    } catch {
      if (this.isCurrentOperation(operation)) await this.restore(previous, operation);
    }
  }

  private async applyOrRestore(next: boolean, previous: boolean, operation: number): Promise<void> {
    try {
      await this.apply(next, operation);
    } catch (error) {
      if (this.isCurrentOperation(operation)) {
        await this.restoreConfiguration(previous, operation);
        await this.restore(previous, operation);
      }
      throw error;
    }
  }

  private async apply(enabled: boolean, operation: number): Promise<void> {
    if (!this.isCurrentOperation(operation)) return;
    this.decorations.setEnabled(enabled);
    await this.editors.setEnabled(enabled);
    if (!this.isCurrentOperation(operation)) return;
    await this.quickDiff?.setEnabled(enabled);
    if (!this.isCurrentOperation(operation)) return;
    await this.setVisualsEnabled(enabled);
    if (!this.isCurrentOperation(operation)) return;
    this.enabled = enabled;
  }

  private async restore(enabled: boolean, operation: number): Promise<void> {
    if (!this.isCurrentOperation(operation)) return;
    try {
      this.decorations.setEnabled(enabled);
    } catch {
      // Preserve the original failure while restoring the independent editor layer.
    }
    try {
      await this.editors.setEnabled(enabled);
    } catch {
      // Preserve the original failure while restoring the context key.
    }
    if (!this.isCurrentOperation(operation)) return;
    try {
      await this.quickDiff?.setEnabled(enabled);
    } catch {
      // Preserve the original failure while restoring the context key.
    }
    if (!this.isCurrentOperation(operation)) return;
    try {
      await this.setVisualsEnabled(enabled);
    } catch {
      // The extension cannot repair a failed VS Code command invocation.
    }
    if (this.isCurrentOperation(operation)) this.enabled = enabled;
  }

  private async restoreConfiguration(enabled: boolean, operation: number): Promise<void> {
    if (!this.isCurrentOperation(operation)) return;
    try {
      await vscode.workspace.getConfiguration('myCode')
        .update('visuals.enabled', enabled, vscode.ConfigurationTarget.Workspace);
    } catch {
      // The visual providers are restored even if VS Code rejects the rollback write.
    }
  }

  private setVisualsEnabled(enabled: boolean): Promise<void> {
    const previous = this.contextWrite;
    const execute = (): Promise<void> => Promise.resolve(
      vscode.commands.executeCommand('setContext', 'myCode.visualsEnabled', enabled)
    ).then(() => undefined);
    const write = previous === undefined
      ? execute()
      : previous.catch(() => undefined).then(execute);
    this.contextWrite = write;
    void write.then(
      () => { if (this.contextWrite === write) this.contextWrite = undefined; },
      () => { if (this.contextWrite === write) this.contextWrite = undefined; }
    );
    return write;
  }

  private async restoreLegacyScmDecorations(): Promise<void> {
    const snapshot = this.state?.get<ScmDecorationSnapshot>(SCM_DECORATION_STATE);
    if (snapshot === undefined) return;
    const configuration = vscode.workspace.getConfiguration('scm');
    const current = configuration.inspect?.<string>('diffDecorations')?.workspaceValue;
    if (current === 'none') {
      await configuration.update(
        'diffDecorations',
        snapshot.hasWorkspaceValue ? snapshot.value : undefined,
        vscode.ConfigurationTarget.Workspace
      );
    }
    await this.state?.update(SCM_DECORATION_STATE, undefined);
  }

  private isCurrentOperation(operation: number): boolean {
    return this.operation === operation;
  }

  private visualsEnabled(): boolean {
    return vscode.workspace.getConfiguration('myCode').get<boolean>('visuals.enabled', true);
  }
}
