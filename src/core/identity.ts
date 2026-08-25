import type { GitIdentity } from './model.js';

export function normalizeIdentityPart(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase();
}

export function normalizeEmail(value: string): string {
  const trimmed = value.trim();
  const unwrapped = trimmed.startsWith('<') && trimmed.endsWith('>')
    ? trimmed.slice(1, -1).trim()
    : trimmed;

  return unwrapped.normalize('NFKC').toLocaleLowerCase();
}

export function matchesIdentity(
  identity: GitIdentity,
  authorName: string,
  authorEmail: string
): boolean {
  return normalizeIdentityPart(identity.name) === normalizeIdentityPart(authorName)
    || normalizeEmail(identity.email) === normalizeEmail(authorEmail);
}
