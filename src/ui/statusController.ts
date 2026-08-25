import type { RepositoryRegistry } from '../extension/repositoryRegistry.js';

export interface StatusAccess {
  text: string;
  show(): void;
}

export interface StatusControllerActions {
  readonly showWarning: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  readonly showOutput: () => void;
  readonly retryIdentity: () => void | Promise<void>;
}

export class StatusController {
  private readonly registrySubscription: { dispose(): void };
  private missingGitWarningShown = false;
  private missingIdentityWarningShown = false;
  private disposed = false;

  public constructor(
    private readonly registry: RepositoryRegistry,
    private readonly status: StatusAccess,
    private readonly actions: StatusControllerActions
  ) {
    this.registrySubscription = registry.onDidChange(() => this.render());
    this.status.show();
    this.render();
  }

  public reportMissingGit(_error: unknown): void {
    if (this.disposed || this.missingGitWarningShown) return;
    this.missingGitWarningShown = true;
    void this.actions.showWarning(
      'My Code could not run Git. Install Git or make it available on PATH, then open the output for details.',
      'My Code: Show Output'
    ).then((selection) => {
      if (selection === 'My Code: Show Output') this.actions.showOutput();
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registrySubscription.dispose();
  }

  private render(): void {
    if (this.disposed) return;
    const snapshots = this.registry.repositories
      .filter(({ ready }) => ready)
      .map(({ analyzer }) => analyzer.getSnapshot());
    const missingIdentity = snapshots.some(({ identity }) =>
      identity.name.trim().length === 0 && identity.email.trim().length === 0
    );
    if (missingIdentity) {
      this.status.text = '$(warning) My Code: Git identity';
      this.warnMissingIdentity();
      return;
    }
    if (snapshots.some(({ scanning }) => scanning)) {
      this.status.text = '$(sync~spin) My Code: Scanning';
      return;
    }
    const fileCount = snapshots.reduce((total, snapshot) => total + snapshot.files.length, 0);
    this.status.text = `$(account) My Code: ${fileCount} files`;
  }

  private warnMissingIdentity(): void {
    if (this.missingIdentityWarningShown) return;
    this.missingIdentityWarningShown = true;
    void this.actions.showWarning(
      'My Code could not find a global Git identity. Configure user.name or user.email, then retry.',
      'My Code: Retry'
    ).then((selection) => {
      if (selection === 'My Code: Retry') void this.actions.retryIdentity();
    });
  }
}
