import * as vscode from 'vscode';

import type { MyCodeDecorationProvider } from './fileDecorations.js';
import type { EditorOwnershipController } from './editorOwnership.js';

export class MyCodeViewController implements vscode.Disposable {
  public async collapseAll(): Promise<void> {
    await vscode.commands.executeCommand('myCode.explorer.focus');
    await vscode.commands.executeCommand('list.collapseAll');
  }

  public dispose(): void {}
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
    private readonly quickDiff?: { setEnabled(enabled: boolean): void | Promise<void> },
    private readonly onError?: (error: unknown) => void
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
    } catch (error) {
      this.onError?.(error);
    }
    if (!this.isCurrentOperation(operation)) return;
    try {
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
