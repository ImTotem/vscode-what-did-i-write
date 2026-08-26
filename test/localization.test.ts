import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

type Messages = Readonly<Record<string, string>>;
type Manifest = {
  readonly displayName?: string;
  readonly description?: string;
  readonly l10n?: string;
  readonly contributes?: {
    readonly commands?: readonly { readonly title?: string }[];
    readonly configuration?: {
      readonly title?: string;
      readonly properties?: Readonly<Record<string, { readonly description?: string }>>;
    };
    readonly colors?: readonly { readonly description?: string }[];
    readonly viewsContainers?: {
      readonly activitybar?: readonly { readonly title?: string }[];
    };
    readonly views?: Readonly<Record<string, readonly { readonly name?: string }[]>>;
    readonly viewsWelcome?: readonly { readonly contents?: string }[];
  };
};

describe('localization contract', () => {
  it('resolves every user-facing manifest value in English and Korean', () => {
    expect(existsSync('package.nls.json')).toBe(true);
    expect(existsSync('package.nls.ko.json')).toBe(true);

    const manifest = readJson<Manifest>('package.json');
    const english = readJson<Messages>('package.nls.json');
    const korean = readJson<Messages>('package.nls.ko.json');
    const values = manifestValues(manifest);

    expect(manifest.l10n).toBe('./l10n');
    expect(values.length).toBeGreaterThan(30);
    for (const value of values) {
      const key = placeholderKey(value);
      expect(key, `${value} must use a package.nls placeholder`).toBeDefined();
      expect(english[key as string], `missing English message for ${key}`).toBeTypeOf('string');
      expect(korean[key as string], `missing Korean message for ${key}`).toBeTypeOf('string');
      expect((korean[key as string] ?? '').trim(), `empty Korean message for ${key}`).not.toBe('');
      expect(placeholders(korean[key as string] ?? '')).toEqual(placeholders(english[key as string] ?? ''));
    }

    expect(resolveMessage(manifest.displayName, english)).toBe('What Did I Write?');
    expect(resolveMessage(manifest.description, english)).toBe('Find the files, lines, and commits you authored.');
    expect(resolveMessage(manifest.description, korean)).toBe('내가 작성한 파일, 코드 줄, 커밋을 찾아보세요.');
    expect(resolveMessage(manifest.contributes?.views?.myCode?.[0]?.name, korean)).toBe('내 변경 사항');
  });

  it('keeps the complete English and Korean runtime catalogs in lockstep', () => {
    expect(existsSync('l10n/bundle.l10n.json')).toBe(true);
    const english = readJson<Messages>('l10n/bundle.l10n.json');
    const korean = readJson<Messages>('l10n/bundle.l10n.ko.json');
    const englishKeys = Object.keys(english).sort();
    const koreanKeys = Object.keys(korean).sort();

    expect(englishKeys.length).toBeGreaterThan(80);
    expect(koreanKeys).toEqual(englishKeys);
    for (const key of englishKeys) {
      expect((english[key] ?? '').trim(), `empty English runtime message for ${key}`).not.toBe('');
      expect((korean[key] ?? '').trim(), `empty Korean runtime message for ${key}`).not.toBe('');
      expect(placeholders(korean[key] ?? '')).toEqual(placeholders(english[key] ?? ''));
    }
  });

  it('ships a Korean runtime bundle for the main interaction surfaces', () => {
    expect(existsSync('l10n/bundle.l10n.ko.json')).toBe(true);
    const korean = readJson<Messages>('l10n/bundle.l10n.ko.json');

    expect(korean['Current changes']).toBe('현재 변경 사항');
    expect(korean['Loading history']).toBe('히스토리를 불러오는 중');
    expect(korean['Past activity is read-only.']).toBe('과거 활동은 읽기 전용입니다.');
    expect(korean['Refresh']).toBe('새로 고침');
  });
});

function manifestValues(manifest: Manifest): string[] {
  const contributes = manifest.contributes;
  return [
    manifest.displayName,
    manifest.description,
    ...((contributes?.commands ?? []).map(({ title }) => title)),
    contributes?.configuration?.title,
    ...Object.values(contributes?.configuration?.properties ?? {}).map(({ description }) => description),
    ...((contributes?.colors ?? []).map(({ description }) => description)),
    ...((contributes?.viewsContainers?.activitybar ?? []).map(({ title }) => title)),
    ...Object.values(contributes?.views ?? {}).flatMap((views) => views.map(({ name }) => name)),
    ...((contributes?.viewsWelcome ?? []).map(({ contents }) => contents))
  ].filter((value): value is string => typeof value === 'string');
}

function placeholderKey(value: string): string | undefined {
  const match = /^%([^%]+)%$/.exec(value);
  return match?.[1];
}
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined)
    .sort();
}

function resolveMessage(value: string | undefined, messages: Messages): string | undefined {
  if (value === undefined) return undefined;
  const key = placeholderKey(value);
  return key === undefined ? value : messages[key];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
