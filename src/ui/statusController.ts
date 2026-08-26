import type { RepositoryRegistry } from '../extension/repositoryRegistry.js';
import type { LocalizationArgs, Localize } from '../localization.js';

export interface StatusAccess {
  text: string;
  show(): void;
}

export interface StatusControllerActions {
  readonly showWarning: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  readonly showOutput: () => void;
  readonly retryIdentity: () => void | Promise<void>;
  readonly localize?: Localize;
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
    const retry = this.t('What Did I Write?: Retry');
    const showOutput = this.t('What Did I Write?: Show Output');
    void this.actions.showWarning(
      this.t('What Did I Write? could not run Git. Install Git or make it available on PATH, then open the output for details.'),
      retry,
      showOutput
    ).then((selection) => {
      if (selection === retry) void this.actions.retryIdentity();
      else if (selection === showOutput) this.actions.showOutput();
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registrySubscription.dispose();
  }

  private render(): void {
    if (this.disposed) return;
    if (this.registry.state === 'discovering' || this.registry.state === 'initializing') {
      this.status.text = '$(sync~spin) ' + this.t('What Did I Write?: Scanning');
      return;
    }
    if (this.registry.state === 'error') {
      this.status.text = '$(warning) ' + this.t('What Did I Write?: Error');
      return;
    }
    const snapshots = this.registry.repositories
      .filter(({ state }) => state === 'ready')
      .map(({ analyzer }) => analyzer.getSnapshot());
    const missingIdentity = snapshots.some(({ identity }) =>
      identity.name.trim().length === 0 && identity.email.trim().length === 0
    );
    if (missingIdentity) {
      this.status.text = '$(warning) ' + this.t('What Did I Write?: Git identity');
      this.warnMissingIdentity();
      return;
    }
    if (snapshots.some(({ scanning }) => scanning)) {
      this.status.text = '$(sync~spin) ' + this.t('What Did I Write?: Scanning');
      return;
    }
    const fileCount = snapshots.reduce((total, snapshot) => total + snapshot.files.length, 0);
    this.status.text = '$(account) ' + this.t('What Did I Write?: {count} files', { count: fileCount });
  }

  private warnMissingIdentity(): void {
    if (this.missingIdentityWarningShown) return;
    this.missingIdentityWarningShown = true;
    const retry = this.t('What Did I Write?: Retry');
    void this.actions.showWarning(
      this.t('What Did I Write? could not find a global Git identity. Configure user.name or user.email, then retry.'),
      retry
    ).then((selection) => {
      if (selection === retry) void this.actions.retryIdentity();
    });
  }

  private t(message: string, args?: LocalizationArgs): string {
    if (this.actions.localize !== undefined) return this.actions.localize(message, args);
    if (args === undefined) return message;
    return message.replace(/\{([^{}]+)\}/g, (placeholder, key: string) =>
      Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : placeholder);
  }
}
