import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import * as vscode from 'vscode';

import { hasConfiguredIdentity } from '../core/identity.js';
import type { FileRecord, OwnedRange } from '../core/model.js';
import type { RegisteredRepository, RepositoryRegistry } from '../extension/repositoryRegistry.js';

export const OWNERSHIP_ORIGINAL_SCHEME = 'my-code-original';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNMATERIALIZED_FINGERPRINT = '\0unmaterialized';

export interface OwnershipOriginalDocument {
  readonly root: string;
  readonly path: string;
}

export interface OwnershipSnapshotState {
  isDocumentSnapshotCurrent(document: vscode.TextDocument): boolean;
  isUriSnapshotCurrent(uri: vscode.Uri): boolean;
  readonly onDidChangeSnapshotState: vscode.Event<vscode.Uri>;
}

interface TrackedOriginal extends OwnershipOriginalDocument {
  readonly uri: vscode.Uri;
  readonly sourceUri: vscode.Uri;
  observedFingerprint: string;
  materializedFingerprint: string;
  notifiedFingerprint?: string;
  materializationGeneration: number;
}

export function ownershipOriginalUri(root: string, path: string): vscode.Uri {
  const descriptor = validateDescriptor({ root, path });
  const payload = Buffer.from(JSON.stringify(descriptor), 'utf8').toString('base64url');
  return vscode.Uri.from({ scheme: OWNERSHIP_ORIGINAL_SCHEME, authority: '', path: `/${payload}` });
}

export function parseOwnershipOriginalUri(uri: vscode.Uri): OwnershipOriginalDocument {
  if (uri.scheme !== OWNERSHIP_ORIGINAL_SCHEME) throw new Error('Unexpected ownership original URI scheme.');
  if (uri.authority !== '' || uri.query !== '' || uri.fragment !== '') {
    throw new Error('Invalid ownership original URI components.');
  }
  const encoded = uri.path.startsWith('/') ? uri.path.slice(1) : '';
  if (!BASE64URL_PATTERN.test(encoded)) throw new Error('Invalid ownership original URI payload.');
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error('Non-canonical payload.');
    return validateDescriptor(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid ownership')) throw error;
    throw new Error('Invalid ownership original URI payload.');
  }
}

export function omitOwnedLines(text: string, ranges: readonly Pick<OwnedRange, 'start' | 'endExclusive'>[]): string {
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  if (lines.length === 0 || ranges.length === 0) return text;
  const omitted = new Uint8Array(lines.length);
  for (const range of ranges) {
    const start = Math.max(0, Math.min(lines.length, range.start));
    const end = Math.max(start, Math.min(lines.length, range.endExclusive));
    omitted.fill(1, start, end);
  }
  return lines.filter((_line, index) => omitted[index] === 0).join('');
}

export class OwnershipQuickDiffController implements
vscode.QuickDiffProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly sourceControls = new Map<string, vscode.SourceControl>();
  private readonly trackedOriginals = new Map<string, TrackedOriginal>();
  private readonly cachedContents = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[];
  private readonly snapshotState: OwnershipSnapshotState;
  private enabled = false;
  private disposed = false;
  private generation = 0;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly registry: RepositoryRegistry,
    snapshotState: OwnershipSnapshotState | ((document: vscode.TextDocument) => boolean),
    private readonly onError?: (error: unknown, operation: string, path: string) => void
  ) {
    this.snapshotState = typeof snapshotState === 'function'
      ? fallbackSnapshotState(snapshotState)
      : snapshotState;
    this.subscriptions = [
      registry.onDidChange(() => this.acceptRegistryChange()),
      this.snapshotState.onDidChangeSnapshotState((uri) => this.acceptSnapshotStateChange(uri))
    ];
    this.syncSourceControls();
  }

  public setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.enabled !== enabled) this.generation += 1;
    this.enabled = enabled;
    this.syncSourceControls();
    for (const sourceControl of this.sourceControls.values()) {
      sourceControl.quickDiffProvider = enabled ? this : undefined;
    }
    if (!enabled) {
      for (const tracked of this.trackedOriginals.values()) tracked.notifiedFingerprint = undefined;
    } else {
      this.acceptRegistryChange();
    }
    return Promise.resolve();
  }

  public async provideOriginalResource(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): Promise<vscode.Uri | undefined> {
    const generation = this.generation;
    if (!this.isOperationCurrent(generation, token) || uri.scheme !== 'file') return undefined;
    const entry = this.registry.findByUri(uri);
    if (!this.isRepositoryActive(entry)) return undefined;
    const path = workspaceRelativePath(entry.root, uri.fsPath);
    if (path === undefined) return undefined;
    let record: FileRecord | undefined;
    try {
      record = await entry.analyzer.ensureFile(path, 'active-editor');
    } catch (error) {
      if (this.isOperationCurrent(generation, token) && entry.analyzer.reportsErrors !== true) {
        this.onError?.(error, 'quick-diff', path);
      }
      return undefined;
    }
    if (!this.isOperationCurrent(generation, token) || !this.isRepositoryActive(entry)) return undefined;
    if (record === undefined || record.binary || record.ranges.length === 0) return undefined;
    const original = ownershipOriginalUri(entry.root, record.relativePath);
    this.trackOriginal(original, entry, record);
    return original;
  }

  public async provideTextDocumentContent(
    uri: vscode.Uri,
    token?: vscode.CancellationToken
  ): Promise<string> {
    const descriptor = parseOwnershipOriginalUri(uri);
    const key = uri.toString();
    const cached = this.cachedContents.get(key);
    const generation = this.generation;
    if (!this.isOperationCurrent(generation, token)) return cached ?? '';
    const entry = this.findRepository(descriptor.root);
    if (!this.isRepositoryActive(entry)) return cached ?? '';
    const sourceUri = vscode.Uri.file(join(entry.root, descriptor.path));
    const tracked = this.ensureTrackedOriginal(uri, sourceUri, entry, descriptor.path);
    const materialization = ++tracked.materializationGeneration;
    const requestedFingerprint = tracked.notifiedFingerprint ?? tracked.observedFingerprint;
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(sourceUri);
    } catch (error) {
      if (this.canSettleMaterialization(tracked, materialization, generation, entry)) {
        this.clearMaterializationNotification(tracked, requestedFingerprint);
        this.onError?.(error, 'quick-diff-content', descriptor.path);
      }
      return this.cachedContents.get(key) ?? cached ?? '';
    }
    if (!this.isLatestMaterialization(tracked, materialization)) {
      return this.cachedContents.get(key) ?? cached ?? document.getText();
    }
    if (!this.isOperationCurrent(generation) || !this.isRepositoryActive(entry)) {
      return this.cachedContents.get(key) ?? cached ?? document.getText();
    }
    if (isCancellationRequested(token)) {
      this.retryMaterialization(tracked, materialization, generation, entry, requestedFingerprint);
      return this.cachedContents.get(key) ?? cached ?? document.getText();
    }
    const documentVersion = document.version;
    if (!this.snapshotState.isDocumentSnapshotCurrent(document)) {
      this.retryMaterialization(tracked, materialization, generation, entry, requestedFingerprint);
      return this.cachedContents.get(key) ?? cached ?? document.getText();
    }

    let record: FileRecord | undefined;
    try {
      record = await entry.analyzer.ensureFile(descriptor.path, 'active-editor');
    } catch (error) {
      if (this.canSettleMaterialization(tracked, materialization, generation, entry)) {
        this.clearMaterializationNotification(tracked, requestedFingerprint);
        if (entry.analyzer.reportsErrors !== true) {
          this.onError?.(error, 'quick-diff-content', descriptor.path);
        }
      }
      return this.cachedContents.get(key) ?? cached ?? document.getText();
    }
    if (!this.isLatestMaterialization(tracked, materialization)) {
      return this.cachedContents.get(key) ?? cached ?? document.getText();
    }
    if (!this.isOperationCurrent(generation) || !this.isRepositoryActive(entry)) {
      return this.cachedContents.get(key) ?? cached ?? document.getText();
    }
    if (isCancellationRequested(token)
      || document.version !== documentVersion
      || !this.snapshotState.isDocumentSnapshotCurrent(document)) {
      this.retryMaterialization(tracked, materialization, generation, entry, requestedFingerprint);
      return this.cachedContents.get(key) ?? cached ?? document.getText();
    }

    const fingerprint = recordFingerprint(record);
    const currentFingerprint = recordFingerprint(
      entry.analyzer.getSnapshot().files.find(({ relativePath }) => relativePath === descriptor.path)
    );
    tracked.observedFingerprint = currentFingerprint;
    if (fingerprint !== currentFingerprint) {
      this.retryMaterialization(tracked, materialization, generation, entry, requestedFingerprint);
      return this.cachedContents.get(key) ?? cached ?? document.getText();
    }

    const contents = record === undefined || record.binary
      ? document.getText()
      : omitOwnedLines(document.getText(), record.ranges);
    this.cachedContents.set(key, contents);
    tracked.materializedFingerprint = fingerprint;
    tracked.notifiedFingerprint = undefined;
    return contents;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.generation += 1;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const sourceControl of this.sourceControls.values()) sourceControl.dispose();
    this.sourceControls.clear();
    this.trackedOriginals.clear();
    this.cachedContents.clear();
    this.changeEmitter.dispose();
  }

  private acceptRegistryChange(): void {
    if (this.disposed) return;
    this.syncSourceControls();
    for (const [key, tracked] of this.trackedOriginals) {
      const entry = this.findRepository(tracked.root);
      if (!this.isRepositoryActive(entry)) {
        this.trackedOriginals.delete(key);
        this.cachedContents.delete(key);
        continue;
      }
      const record = entry.analyzer.getSnapshot().files.find(({ relativePath }) => relativePath === tracked.path);
      tracked.observedFingerprint = recordFingerprint(record);
      this.requestRefresh(tracked);
    }
  }

  private acceptSnapshotStateChange(uri: vscode.Uri): void {
    if (this.disposed || uri.scheme !== 'file') return;
    const key = uri.toString();
    for (const tracked of this.trackedOriginals.values()) {
      if (tracked.sourceUri.toString() !== key) continue;
      if (!this.snapshotState.isUriSnapshotCurrent(uri)) {
        tracked.notifiedFingerprint = undefined;
        continue;
      }
      this.requestRefresh(tracked);
    }
  }

  private requestRefresh(tracked: TrackedOriginal): void {
    if (!this.enabled || this.disposed) return;
    if (tracked.observedFingerprint === tracked.materializedFingerprint) return;
    if (tracked.notifiedFingerprint === tracked.observedFingerprint) return;
    if (!this.snapshotState.isUriSnapshotCurrent(tracked.sourceUri)) return;
    tracked.notifiedFingerprint = tracked.observedFingerprint;
    this.changeEmitter.fire(tracked.uri);
  }
  private isLatestMaterialization(tracked: TrackedOriginal, materialization: number): boolean {
    return this.trackedOriginals.get(tracked.uri.toString()) === tracked
      && tracked.materializationGeneration === materialization;
  }

  private canSettleMaterialization(
    tracked: TrackedOriginal,
    materialization: number,
    generation: number,
    entry: RegisteredRepository
  ): boolean {
    return this.isLatestMaterialization(tracked, materialization)
      && this.isOperationCurrent(generation)
      && this.isRepositoryActive(entry);
  }

  private clearMaterializationNotification(
    tracked: TrackedOriginal,
    requestedFingerprint: string
  ): void {
    if (tracked.notifiedFingerprint === requestedFingerprint) {
      tracked.notifiedFingerprint = undefined;
    }
  }

  private retryMaterialization(
    tracked: TrackedOriginal,
    materialization: number,
    generation: number,
    entry: RegisteredRepository,
    requestedFingerprint: string
  ): void {
    if (!this.canSettleMaterialization(tracked, materialization, generation, entry)) return;
    this.clearMaterializationNotification(tracked, requestedFingerprint);
    queueMicrotask(() => {
      if (!this.canSettleMaterialization(tracked, materialization, generation, entry)) return;
      this.requestRefresh(tracked);
    });
  }


  private trackOriginal(uri: vscode.Uri, entry: RegisteredRepository, record: FileRecord): TrackedOriginal {
    return this.ensureTrackedOriginal(
      uri,
      vscode.Uri.file(join(entry.root, record.relativePath)),
      entry,
      record.relativePath,
      recordFingerprint(record)
    );
  }

  private ensureTrackedOriginal(
    uri: vscode.Uri,
    sourceUri: vscode.Uri,
    entry: RegisteredRepository,
    path: string,
    observedFingerprint = recordFingerprint(
      entry.analyzer.getSnapshot().files.find(({ relativePath }) => relativePath === path)
    )
  ): TrackedOriginal {
    const key = uri.toString();
    const existing = this.trackedOriginals.get(key);
    if (existing !== undefined) {
      existing.observedFingerprint = observedFingerprint;
      return existing;
    }
    const tracked: TrackedOriginal = {
      uri,
      sourceUri,
      root: entry.root,
      path,
      observedFingerprint,
      materializedFingerprint: UNMATERIALIZED_FINGERPRINT,
      materializationGeneration: 0
    };
    this.trackedOriginals.set(key, tracked);
    return tracked;
  }

  private syncSourceControls(): void {
    const activeRoots = new Set<string>();
    for (const entry of this.registry.repositories) {
      if (!this.isRepositoryActive(entry)) continue;
      const key = normalizedRoot(entry.root);
      activeRoots.add(key);
      if (this.sourceControls.has(key)) continue;
      const sourceControl = vscode.scm.createSourceControl(
        `whatDidIWrite.${rootHash(key)}`,
        'What Did I Write?',
        vscode.Uri.file(entry.root)
      );
      sourceControl.inputBox.visible = false;
      sourceControl.count = 0;
      sourceControl.quickDiffProvider = this.enabled ? this : undefined;
      this.sourceControls.set(key, sourceControl);
    }
    for (const [key, sourceControl] of this.sourceControls) {
      if (activeRoots.has(key)) continue;
      sourceControl.dispose();
      this.sourceControls.delete(key);
    }
  }

  private isOperationCurrent(
    generation: number,
    token?: Pick<vscode.CancellationToken, 'isCancellationRequested'>
  ): boolean {
    return !this.disposed
      && this.enabled
      && this.generation === generation
      && token?.isCancellationRequested !== true;
  }

  private isRepositoryActive(entry: RegisteredRepository | undefined): entry is RegisteredRepository {
    if (entry === undefined || !entry.ready) return false;
    if (this.findRepository(entry.root) !== entry) return false;
    return hasConfiguredIdentity(entry.analyzer.getSnapshot().identity);
  }

  private findRepository(root: string): RegisteredRepository | undefined {
    return this.registry.repositories.find((entry) => normalizedRoot(entry.root) === normalizedRoot(root));
  }
}

function isCancellationRequested(token?: Pick<vscode.CancellationToken, 'isCancellationRequested'>): boolean {
  return token?.isCancellationRequested === true;
}

function fallbackSnapshotState(
  isDocumentSnapshotCurrent: (document: vscode.TextDocument) => boolean
): OwnershipSnapshotState {
  return {
    isDocumentSnapshotCurrent,
    isUriSnapshotCurrent: () => true,
    onDidChangeSnapshotState: () => ({ dispose: () => undefined })
  };
}

function validateDescriptor(value: unknown): OwnershipOriginalDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid ownership original URI descriptor.');
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== 'path,root') {
    throw new Error('Invalid ownership original URI descriptor fields.');
  }
  const { root, path } = object;
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !isAbsolute(root)) {
    throw new Error('Invalid ownership original URI root.');
  }
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isUnsafeRelativePath(path)) {
    throw new Error('Invalid ownership original URI path.');
  }
  return { root: resolve(root), path: path.replace(/\\/g, '/') };
}

function isUnsafeRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || (process.platform === 'win32' && normalized.includes(':'))
    || normalized.split('/').some((segment) => segment === '..' || segment === '');
}

function workspaceRelativePath(root: string, path: string): string | undefined {
  const candidate = relative(root, path);
  if (candidate === '' || isAbsolute(candidate) || candidate === '..' || candidate.startsWith(`..${sep}`)) return undefined;
  return candidate.split(sep).join('/');
}

function recordFingerprint(record: FileRecord | undefined): string {
  if (record === undefined) return 'none';
  return JSON.stringify([
    record.binary,
    record.ranges.map(({ start, endExclusive, uncommitted, commit }) => [
      start, endExclusive, uncommitted, commit?.hash
    ])
  ]);
}

function normalizedRoot(root: string): string {
  const normalized = resolve(root);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function rootHash(root: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < root.length; index += 1) {
    hash ^= root.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
