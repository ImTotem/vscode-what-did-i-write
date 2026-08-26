import * as vscode from 'vscode';

export type LocalizationValue = string | number | boolean;
export type LocalizationArgs = Readonly<Record<string, LocalizationValue>>;
export type Localize = (message: string, args?: LocalizationArgs) => string;

export const localize: Localize = (message, args) => {
  const runtime = (vscode as typeof vscode & {
    readonly l10n?: { t(message: string, args?: LocalizationArgs): string };
  }).l10n;
  if (runtime?.t !== undefined) {
    const translated = args === undefined ? runtime.t(message) : runtime.t(message, args);
    return args === undefined || translated !== message ? translated : interpolate(translated, args);
  }
  return args === undefined ? message : interpolate(message, args);
};

export function displayLanguage(): string {
  const language = (vscode as typeof vscode & {
    readonly env?: { readonly language?: string };
  }).env?.language;
  return language === undefined || language.trim() === '' ? 'en' : language;
}

export function formatDate(authoredAt: number): string {
  return new Intl.DateTimeFormat(displayLanguage(), { dateStyle: 'short' })
    .format(new Date(authoredAt * 1_000));
}

export function formatDateTime(authoredAt: number): string {
  return new Intl.DateTimeFormat(displayLanguage(), {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(authoredAt * 1_000));
}

export function formatRelativeDate(authoredAt: number, now: number): string {
  const elapsedSeconds = Math.round((authoredAt * 1_000 - now) / 1_000);
  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60]
  ];
  const formatter = new Intl.RelativeTimeFormat(displayLanguage(), { numeric: 'always' });
  for (const [unit, seconds] of units) {
    if (Math.abs(elapsedSeconds) >= seconds) {
      return formatter.format(Math.round(elapsedSeconds / seconds), unit);
    }
  }
  return formatter.format(elapsedSeconds, 'second');
}

function interpolate(message: string, args: LocalizationArgs): string {
  return message.replace(/\{([^{}]+)\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : placeholder);
}
