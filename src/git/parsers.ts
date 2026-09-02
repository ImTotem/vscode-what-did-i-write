import type { CommitSummary, OwnedLine } from '../core/model.js';

export interface LogIndexEntry {
  readonly commit: CommitSummary;
  readonly changes: readonly {
    readonly status: string;
    readonly path: string;
    readonly originalPath?: string;
  }[];
}

export interface WorkingChange {
  readonly status: string;
  readonly path: string;
  readonly originalPath?: string;
}

export interface BlameLine extends OwnedLine {}

export interface NumStatRecord {
  readonly additions: number;
  readonly deletions: number;
  readonly path: string;
}

export class GitParseError extends Error {
  public constructor(
    readonly parser: string,
    readonly byteOffset: number,
    message: string
  ) {
    super(`${parser} at byte offset ${byteOffset}: ${message}`);
    this.name = 'GitParseError';
  }
}

const NUL = 0;

export function parseNumStat(input: Buffer): NumStatRecord[] {
  if (input.length === 0) return [];
  if (input[input.length - 1] !== NUL) {
    throw parseError('parseNumStat', input.length, 'missing NUL record terminator');
  }
  const records: NumStatRecord[] = [];
  for (const raw of input.toString('utf8').split('\0').slice(0, -1)) {
    const parsed = parseNumStatRecord(raw, input, 'parseNumStat');
    if (parsed !== undefined) records.push(parsed);
  }
  return records;
}

export function parseCommitNumStats(input: Buffer): ReadonlyMap<string, readonly NumStatRecord[]> {
  const result = new Map<string, readonly NumStatRecord[]>();
  if (input.length === 0) return result;
  if (input[0] !== NUL || input[input.length - 1] !== NUL) {
    throw parseError('parseCommitNumStats', 0, 'invalid NUL framing');
  }
  const fields = input.toString('utf8').split('\0');
  let cursor = 1;
  while (cursor < fields.length - 1) {
    const hash = fields[cursor] ?? '';
    if (!/^[0-9a-f]+$/i.test(hash)) {
      throw parseError('parseCommitNumStats', byteOffset(input, hash), 'invalid commit hash');
    }
    cursor += 1;
    if ((fields[cursor] ?? '') !== '') {
      throw parseError('parseCommitNumStats', byteOffset(input, fields[cursor] ?? ''), 'missing commit separator');
    }
    cursor += 1;
    const records: NumStatRecord[] = [];
    while (cursor < fields.length - 1 && (fields[cursor] ?? '') !== '') {
      const raw = fields[cursor] as string;
      const parsed = parseNumStatRecord(raw, input, 'parseCommitNumStats');
      if (parsed !== undefined) records.push(parsed);
      cursor += 1;
    }
    result.set(hash, records);
    cursor += 1;
  }
  return result;
}

function parseNumStatRecord(raw: string, input: Buffer, parser: string): NumStatRecord | undefined {
  const record = raw.replace(/^[\r\n]+/, '');
  if (record.length === 0) return undefined;
  const firstTab = record.indexOf('\t');
  const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1);
  if (firstTab < 1 || secondTab < firstTab + 2 || secondTab === record.length - 1) {
    throw parseError(parser, byteOffset(input, raw), 'malformed numstat record');
  }
  const additionsText = record.slice(0, firstTab);
  const deletionsText = record.slice(firstTab + 1, secondTab);
  if (additionsText === '-' && deletionsText === '-') return undefined;
  const additions = Number(additionsText);
  const deletions = Number(deletionsText);
  if (!Number.isSafeInteger(additions) || additions < 0 || !Number.isSafeInteger(deletions) || deletions < 0) {
    throw parseError(parser, byteOffset(input, raw), 'invalid line counts');
  }
  return { additions, deletions, path: record.slice(secondTab + 1) };
}

export function parseLogIndex(input: Buffer): LogIndexEntry[] {
  const entries: LogIndexEntry[] = [];
  const fields = splitNulFields(input, 'parseLogIndex');
  if (fields.length === 0) return entries;
  requireLeadingSeparator(fields, 'parseLogIndex');
  let cursor = 1;

  while (cursor < fields.length && !isTerminalEmpty(fields, cursor)) {
    const parsed = parseCommitFields(fields, cursor, 'parseLogIndex');
    const commit = parsed.commit;
    cursor = parsed.next;
    requireEmptyField(fields, cursor, 'parseLogIndex', 'missing separator after commit metadata');
    cursor += 1;
    const changes: Array<LogIndexEntry['changes'][number]> = [];
    while (cursor < fields.length && fields[cursor]?.bytes.length !== 0) {
      const statusField = fields[cursor];
      const pathField = fields[cursor + 1];
      if (statusField === undefined || pathField === undefined) {
        throw parseError('parseLogIndex', input.length, 'missing change status or path');
      }
      const status = statusField.bytes.toString('utf8').replace(/^[\r\n]+/, '');
      const path = pathField.bytes.toString('utf8');
      if (status.length === 0 || path.length === 0) {
        throw parseError('parseLogIndex', statusField.offset, 'empty change status or path');
      }
      cursor += 2;
      if (/^[RC]\d*$/.test(status)) {
        const renamedPathField = fields[cursor];
        const renamedPath = renamedPathField?.bytes.toString('utf8') ?? '';
        if (renamedPath.length === 0) {
          throw parseError('parseLogIndex', renamedPathField?.offset ?? input.length, 'empty renamed path');
        }
        changes.push({ status, path: renamedPath, originalPath: path });
        cursor += 1;
      } else {
        changes.push({ status, path });
      }
    }

    entries.push({ commit, changes });
    while (cursor < fields.length && fields[cursor]?.bytes.length === 0) {
      cursor += 1;
    }
  }

  return entries;
}

export function parseHistoryRecords(input: Buffer): CommitSummary[] {
  const commits: CommitSummary[] = [];
  const fields = splitNulFields(input, 'parseHistoryRecords');
  if (fields.length === 0) return commits;
  requireLeadingSeparator(fields, 'parseHistoryRecords');
  let cursor = 1;
  while (cursor < fields.length && !isTerminalEmpty(fields, cursor)) {
    const parsed = parseCommitFields(fields, cursor, 'parseHistoryRecords');
    commits.push(parsed.commit);
    cursor = parsed.next;
    requireEmptyField(fields, cursor, 'parseHistoryRecords', 'missing separator after commit metadata');
    while (cursor < fields.length && fields[cursor]?.bytes.length === 0) {
      cursor += 1;
    }
  }

  return commits;
}

export function parsePorcelainV2Status(input: Buffer): WorkingChange[] {
  const changes: WorkingChange[] = [];
  if (input.length === 0) return changes;
  if (input[input.length - 1] !== NUL) {
    throw parseError('parsePorcelainV2Status', input.length, 'missing NUL record terminator');
  }
  const records = input.toString('utf8').split('\0');

  for (let index = 0; index < records.length - 1; index += 1) {
    const record = records[index] ?? '';
    if (record.length === 0) continue;
    const type = record[0];
    if (type === '?' || type === '!') {
      if (record[1] !== ' ') {
        throw parseError('parsePorcelainV2Status', byteOffset(input, record), 'missing status-path separator');
      }
      changes.push({ status: type, path: requiredPath(record.slice(2), 'parsePorcelainV2Status', input, record) });
      continue;
    }

    const requiredFields = type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : 0;
    if (requiredFields === 0 || record[1] !== ' ') {
      throw parseError('parsePorcelainV2Status', byteOffset(input, record), `unsupported status record ${JSON.stringify(type)}`);
    }
    const fields = prefixFields(record, requiredFields);
    const path = requiredPath(fields.remainder, 'parsePorcelainV2Status', input, record);
    const status = fields.values[1];
    if (status === undefined || status.length !== 2) {
      throw parseError('parsePorcelainV2Status', byteOffset(input, record), 'missing XY status');
    }
    if (type === '2') {
      const originalPath = records[index + 1];
      if (originalPath === undefined || originalPath.length === 0) {
        throw parseError('parsePorcelainV2Status', byteOffset(input, record), 'missing rename source path');
      }
      changes.push({ status, path, originalPath });
      index += 1;
    } else {
      changes.push({ status, path });
    }
  }

  return changes;
}

export function parseLinePorcelainBlame(input: string): BlameLine[] {
  const lines = input.split('\n');
  const result: BlameLine[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index] ?? '';
    if (header.length === 0) {
      index += 1;
      continue;
    }
    const match = /^([0-9a-f]{40,64}|[0-9a-f]+) (\d+) (\d+)(?: (\d+))?(?: .*)?$/i.exec(header);
    if (match === null) throw parseError('parseLinePorcelainBlame', byteOffsetString(input, index), 'invalid blame header');
    const hash = match[1] as string;
    const finalLine = Number(match[3]);
    if (!Number.isSafeInteger(finalLine) || finalLine < 1) {
      throw parseError('parseLinePorcelainBlame', byteOffsetString(input, index), 'invalid blame line number');
    }
    index += 1;
    const fields = new Map<string, string>();
    while (index < lines.length && !(lines[index] ?? '').startsWith('\t')) {
      const field = lines[index] ?? '';
      const separator = field.indexOf(' ');
      if (separator > 0) fields.set(field.slice(0, separator), field.slice(separator + 1));
      index += 1;
    }
    if (index >= lines.length) throw parseError('parseLinePorcelainBlame', input.length, 'missing source line');
    index += 1;

    const uncommitted = /^0{40,64}$/.test(hash);
    const commit = uncommitted ? undefined : blameCommit(hash, fields, input, index);
    result.push({ line: finalLine - 1, uncommitted, commit });
  }
  return result;
}

interface NulField {
  readonly bytes: Buffer;
  readonly offset: number;
}

function splitNulFields(input: Buffer, parser: string): NulField[] {
  if (input.length === 0) return [];
  if (input[0] !== NUL) throw parseError(parser, 0, 'missing leading NUL record separator');
  if (input[input.length - 1] !== NUL) {
    throw parseError(parser, input.length, 'missing NUL field terminator');
  }
  const fields: NulField[] = [];
  let start = 0;
  while (start < input.length) {
    const end = input.indexOf(NUL, start);
    if (end === -1) throw parseError(parser, start, 'missing NUL field terminator');
    fields.push({ bytes: input.subarray(start, end), offset: start });
    start = end + 1;
  }
  fields.push({ bytes: Buffer.alloc(0), offset: input.length });
  return fields;
}

function requireLeadingSeparator(fields: readonly NulField[], parser: string): void {
  if (fields[0]?.bytes.length !== 0) {
    throw parseError(parser, fields[0]?.offset ?? 0, 'missing leading NUL record separator');
  }
}

function requireEmptyField(
  fields: readonly NulField[],
  cursor: number,
  parser: string,
  message: string
): void {
  const field = fields[cursor];
  if (field === undefined || field.bytes.length !== 0) {
    throw parseError(parser, field?.offset ?? fields.at(-1)?.offset ?? 0, message);
  }
}

function isTerminalEmpty(fields: readonly NulField[], cursor: number): boolean {
  return cursor === fields.length - 1 && fields[cursor]?.bytes.length === 0;
}

function parseCommitFields(
  fields: readonly NulField[],
  cursor: number,
  parser: string
): { readonly commit: CommitSummary; readonly next: number } {
  const values = fields.slice(cursor, cursor + 5);
  if (values.length !== 5) {
    throw parseError(parser, fields[cursor]?.offset ?? 0, 'expected five commit fields');
  }
  const [hashField, authorNameField, authorEmailField, authoredAtField, subjectField] = values;
  const hash = hashField?.bytes.toString('utf8') ?? '';
  const authorName = authorNameField?.bytes.toString('utf8') ?? '';
  const authorEmail = authorEmailField?.bytes.toString('utf8') ?? '';
  const authoredAtText = authoredAtField?.bytes.toString('utf8') ?? '';
  const subject = subjectField?.bytes.toString('utf8') ?? '';
  const authoredAt = Number(authoredAtText);
  if (!hash || !authorName || !authorEmail || !authoredAtText || !Number.isSafeInteger(authoredAt)) {
    throw parseError(parser, Math.max(0, (hashField?.offset ?? 1) - 1), 'invalid mandatory commit field');
  }
  return {
    commit: { hash, authorName, authorEmail, authoredAt, subject },
    next: cursor + 5
  };
}

function blameCommit(hash: string, fields: Map<string, string>, input: string, index: number): CommitSummary {
  const authorName = fields.get('author');
  const authorEmail = fields.get('author-mail')?.replace(/^<|>$/g, '');
  const authoredAtText = fields.get('author-time');
  const authoredAt = Number(authoredAtText);
  const subject = fields.get('summary');
  if (!authorName || !authorEmail || !authoredAtText || subject === undefined || !Number.isSafeInteger(authoredAt)) {
    throw parseError('parseLinePorcelainBlame', byteOffsetString(input, index), 'invalid mandatory blame metadata');
  }
  return { hash, authorName, authorEmail, authoredAt, subject };
}

function prefixFields(record: string, count: number): { values: string[]; remainder: string } {
  const values: string[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const separator = record.indexOf(' ', cursor);
    if (separator === -1) return { values, remainder: '' };
    values.push(record.slice(cursor, separator));
    cursor = separator + 1;
  }
  return { values, remainder: record.slice(cursor) };
}

function requiredPath(path: string, parser: string, input: Buffer, record: string): string {
  if (path.length === 0) throw parseError(parser, byteOffset(input, record), 'missing path');
  return path;
}

function byteOffset(input: Buffer, record: string): number {
  return input.indexOf(Buffer.from(record));
}

function byteOffsetString(input: string, lineIndex: number): number {
  return Buffer.byteLength(input.split('\n').slice(0, lineIndex).join('\n')) + (lineIndex === 0 ? 0 : 1);
}

function parseError(parser: string, byteOffset: number, message: string): GitParseError {
  return new GitParseError(parser, byteOffset, message);
}
