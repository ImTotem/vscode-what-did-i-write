import * as vscode from 'vscode';

import type { RepositoryRegistry } from '../extension/repositoryRegistry.js';

export const GIT_CONTENT_SCHEME = 'my-code-git';

const REVISION_PATTERN = /^[0-9a-f]{7,64}(?:\^)?$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface RevisionDocument {
  readonly root: string;
  readonly revision: string;
  readonly path: string;
}

interface RevisionRepository {
  showFile(revision: string, path: string): Promise<Buffer | undefined>;
}

export class InvalidRevisionUriError extends Error {
  public constructor(message: string) {
    super(`Invalid What Did I Write? revision URI: ${message}`);
    this.name = 'InvalidRevisionUriError';
  }
}

export function revisionUri(root: string, revision: string, path: string): vscode.Uri {
  const descriptor = validateDescriptor({ root, revision, path });
  const payload = Buffer.from(JSON.stringify(descriptor), 'utf8').toString('base64url');
  return vscode.Uri.from({ scheme: GIT_CONTENT_SCHEME, authority: '', path: `/${payload}` });
}

export function parseRevisionUri(uri: vscode.Uri): RevisionDocument {
  if (uri.scheme !== GIT_CONTENT_SCHEME) throw new InvalidRevisionUriError('unexpected scheme');
  if (uri.authority !== '') throw new InvalidRevisionUriError('authority must be empty');
  if (uri.query !== '' || uri.fragment !== '') throw new InvalidRevisionUriError('query and fragment must be empty');
  const encoded = uri.path.startsWith('/') ? uri.path.slice(1) : '';
  if (!BASE64URL_PATTERN.test(encoded)) throw new InvalidRevisionUriError('malformed base64url payload');

  let parsed: unknown;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error('non-canonical base64url');
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new InvalidRevisionUriError('malformed JSON payload');
  }
  return validateDescriptor(parsed);
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  public constructor(
    private readonly registry: RepositoryRegistry,
    private readonly onError?: (error: unknown, operation: string, path: string) => void
  ) {}

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const descriptor = parseRevisionUri(uri);
    const entry = this.registry.repositories.find(({ root }) => sameRoot(root, descriptor.root));
    if (entry === undefined) return '';
    const repository = entry.repository as unknown as RevisionRepository;
    if (typeof repository.showFile !== 'function') return '';
    let contents: Buffer | undefined;
    try {
      contents = await repository.showFile(descriptor.revision, descriptor.path);
    } catch (error: unknown) {
      this.onError?.(error, 'revision-content', descriptor.path);
      throw error;
    }
    return contents === undefined ? '' : new TextDecoder('utf-8').decode(contents);
  }
}

function validateDescriptor(value: unknown): RevisionDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRevisionUriError('payload must be an object');
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== 'path,revision,root') {
    throw new InvalidRevisionUriError('payload fields are invalid');
  }
  const { root, revision, path } = object;
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    throw new InvalidRevisionUriError('root is invalid');
  }
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
    throw new InvalidRevisionUriError('revision is invalid');
  }
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isUnsafeRelativePath(path)) {
    throw new InvalidRevisionUriError('path is invalid');
  }
  return { root, revision, path };
}

function isUnsafeRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split('/').some((segment) => segment === '..');
}

function sameRoot(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
}
