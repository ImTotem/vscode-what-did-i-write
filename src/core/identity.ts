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

export function hasConfiguredIdentity(identity: GitIdentity): boolean {
  return normalizeIdentityPart(identity.name).length > 0
    || normalizeEmail(identity.email).length > 0;
}

export function matchesIdentity(
  identity: GitIdentity,
  authorName: string,
  authorEmail: string
): boolean {
  const name = normalizeIdentityPart(identity.name);
  const email = normalizeEmail(identity.email);
  return (
    name.length > 0
    && name === normalizeIdentityPart(authorName)
  ) || (
    email.length > 0
    && email === normalizeEmail(authorEmail)
  );
}
