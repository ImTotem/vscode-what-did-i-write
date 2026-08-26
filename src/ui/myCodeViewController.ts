import * as vscode from 'vscode';

import type { MyCodeDecorationProvider } from './fileDecorations.js';
import type { EditorOwnershipController } from './editorOwnership.js';
import type { MyCodeNode, MyCodeTreeProvider } from './myCodeTree.js';

type CurrentTree = Pick<MyCodeTreeProvider, 'expandableNodes' | 'getParent' | 'onDidChangeTreeData'>;

export class MyCodeViewController implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];
  private readonly expanded = new Set<string>();

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
    const nodes = this.provider.expandableNodes();
    try {
      for (const node of nodes) {
        await this.view.reveal(node, { expand: true, select: false, focus: false });
      }
      this.expanded.clear();
      for (const node of nodes) this.expanded.add(node.id);
      await this.setAllExpanded(nodes.length > 0);
    } catch (error) {
      this.expanded.clear();
      await Promise.resolve(this.setAllExpanded(false)).catch(() => undefined);
      throw error;
    }
  }

  public async collapseAll(): Promise<void> {
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

  private resetExpansionState(): void {
    this.expanded.clear();
    void Promise.resolve(this.setAllExpanded(false)).catch(() => undefined);
  }

  private syncExpansionContext(): Promise<void> {
    const nodes = this.provider.expandableNodes();
    const allExpanded = nodes.length > 0 && nodes.every((node) => this.expanded.has(node.id));
    return Promise.resolve(this.setAllExpanded(allExpanded)).then(() => undefined);
  }

  private setAllExpanded(value: boolean): Thenable<unknown> {
    return vscode.commands.executeCommand('setContext', 'myCode.treeAllExpanded', value);
  }
}

export class VisualModeController {
  private enabled = true;

  public constructor(
    private readonly decorations: Pick<MyCodeDecorationProvider, 'setEnabled'>,
    private readonly editors: Pick<EditorOwnershipController, 'setEnabled'>
  ) {
    void this.acceptInitialConfiguration();
  }

  public async toggle(): Promise<void> {
    const previous = this.enabled;
    const next = !this.visualsEnabled();
    const configuration = vscode.workspace.getConfiguration('myCode');
    try {
      await configuration.update('visuals.enabled', next, vscode.ConfigurationTarget.Workspace);
    } catch (error) {
      await this.restore(previous);
      throw error;
    }
    await this.applyOrRestore(next, previous);
  }

  public async acceptConfigurationChange(): Promise<void> {
    const previous = this.enabled;
    await this.applyOrRestore(this.visualsEnabled(), previous);
  }

  private async acceptInitialConfiguration(): Promise<void> {
    const previous = this.enabled;
    try {
      await this.apply(this.visualsEnabled());
    } catch {
      await this.restore(previous);
    }
  }

  private async applyOrRestore(next: boolean, previous: boolean): Promise<void> {
    try {
      await this.apply(next);
    } catch (error) {
      await this.restoreConfiguration(previous);
      await this.restore(previous);
      throw error;
    }
  }

  private async apply(enabled: boolean): Promise<void> {
    this.decorations.setEnabled(enabled);
    await this.editors.setEnabled(enabled);
    await vscode.commands.executeCommand('setContext', 'myCode.visualsEnabled', enabled);
    this.enabled = enabled;
  }

  private async restore(enabled: boolean): Promise<void> {
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
    try {
      await vscode.commands.executeCommand('setContext', 'myCode.visualsEnabled', enabled);
    } catch {
      // The extension cannot repair a failed VS Code command invocation.
    }
    this.enabled = enabled;
  }

  private async restoreConfiguration(enabled: boolean): Promise<void> {
    try {
      await vscode.workspace.getConfiguration('myCode')
        .update('visuals.enabled', enabled, vscode.ConfigurationTarget.Workspace);
    } catch {
      // The visual providers are restored even if VS Code rejects the rollback write.
    }
  }

  private visualsEnabled(): boolean {
    return vscode.workspace.getConfiguration('myCode').get<boolean>('visuals.enabled', true);
  }
}
