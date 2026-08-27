import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import * as vscode from 'vscode';

import { hasConfiguredIdentity } from '../core/identity.js';
import type { FileRecord, OwnedRange } from '../core/model.js';
import type { RegisteredRepository, RepositoryRegistry } from '../extension/repositoryRegistry.js';

export const OWNERSHIP_ORIGINAL_SCHEME = 'my-code-original';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface OwnershipOriginalDocument {
  readonly root: string;
  readonly path: string;
}

interface TrackedOriginal extends OwnershipOriginalDocument {
  readonly uri: vscode.Uri;
  fingerprint: string;
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
  private readonly registrySubscription: vscode.Disposable;
  private enabled = false;
  private disposed = false;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly registry: RepositoryRegistry,
    private readonly isDocumentSnapshotCurrent: (document: vscode.TextDocument) => boolean,
    private readonly onError?: (error: unknown, operation: string, path: string) => void
  ) {
    this.registrySubscription = registry.onDidChange(() => this.acceptRegistryChange());
    this.syncSourceControls();
  }

  public setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.enabled = enabled;
    this.syncSourceControls();
    for (const sourceControl of this.sourceControls.values()) {
      sourceControl.quickDiffProvider = enabled ? this : undefined;
    }
    return Promise.resolve();
  }

  public async provideOriginalResource(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): Promise<vscode.Uri | undefined> {
    if (!this.enabled || uri.scheme !== 'file' || token.isCancellationRequested) return undefined;
    const entry = this.registry.findByUri(uri);
    if (entry === undefined || !entry.ready) return undefined;
    const snapshot = entry.analyzer.getSnapshot();
    if (!hasConfiguredIdentity(snapshot.identity)) return undefined;
    const path = workspaceRelativePath(entry.root, uri.fsPath);
    if (path === undefined) return undefined;
    let record: FileRecord | undefined;
    try {
      record = await entry.analyzer.ensureFile(path, 'active-editor');
    } catch (error) {
      this.onError?.(error, 'quick-diff', path);
      return undefined;
    }
    if (token.isCancellationRequested || record === undefined || record.binary || record.ranges.length === 0) {
      return undefined;
    }
    const original = ownershipOriginalUri(entry.root, record.relativePath);
    this.trackedOriginals.set(original.toString(), {
      uri: original,
      root: entry.root,
      path: record.relativePath,
      fingerprint: recordFingerprint(record)
    });
    return original;
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const descriptor = parseOwnershipOriginalUri(uri);
    const entry = this.findRepository(descriptor.root);
    if (entry === undefined || !entry.ready) return '';
    const source = vscode.Uri.file(join(entry.root, descriptor.path));
    const document = await vscode.workspace.openTextDocument(source);
    const key = uri.toString();
    const cached = this.cachedContents.get(key);
    if (!this.isDocumentSnapshotCurrent(document)) return cached ?? document.getText();

    let record: FileRecord | undefined;
    try {
      record = await entry.analyzer.ensureFile(descriptor.path, 'active-editor');
    } catch (error) {
      this.onError?.(error, 'quick-diff-content', descriptor.path);
      return cached ?? document.getText();
    }
    const contents = record === undefined || record.binary
      ? document.getText()
      : omitOwnedLines(document.getText(), record.ranges);
    this.cachedContents.set(key, contents);
    this.trackedOriginals.set(key, {
      uri,
      root: entry.root,
      path: descriptor.path,
      fingerprint: recordFingerprint(record)
    });
    return contents;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registrySubscription.dispose();
    for (const sourceControl of this.sourceControls.values()) sourceControl.dispose();
    this.sourceControls.clear();
    this.trackedOriginals.clear();
    this.cachedContents.clear();
    this.changeEmitter.dispose();
  }

  private acceptRegistryChange(): void {
    if (this.disposed) return;
    this.syncSourceControls();
    for (const tracked of this.trackedOriginals.values()) {
      const entry = this.findRepository(tracked.root);
      const record = entry?.analyzer.getSnapshot().files.find(({ relativePath }) => relativePath === tracked.path);
      const fingerprint = recordFingerprint(record);
      if (fingerprint === tracked.fingerprint) continue;
      tracked.fingerprint = fingerprint;
      this.changeEmitter.fire(tracked.uri);
    }
  }

  private syncSourceControls(): void {
    const activeRoots = new Set<string>();
    for (const entry of this.registry.repositories) {
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

  private findRepository(root: string): RegisteredRepository | undefined {
    return this.registry.repositories.find((entry) => normalizedRoot(entry.root) === normalizedRoot(root));
  }
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
    || /^[A-Za-z]:\//.test(normalized)
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
