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

const RECORD_SEPARATOR = 0x1e;
const FIELD_SEPARATOR = 0x1f;
const NUL = 0;

export function parseLogIndex(input: Buffer): LogIndexEntry[] {
  const entries: LogIndexEntry[] = [];
  let recordOffset = input.indexOf(RECORD_SEPARATOR);

  while (recordOffset !== -1) {
    const metadataEnd = input.indexOf(NUL, recordOffset + 1);
    if (metadataEnd === -1) {
      throw parseError('parseLogIndex', recordOffset, 'missing NUL after commit metadata');
    }

    const commit = parseCommit(input.subarray(recordOffset + 1, metadataEnd), 'parseLogIndex', recordOffset);
    const nextRecord = input.indexOf(RECORD_SEPARATOR, metadataEnd + 1);
    const recordEnd = nextRecord === -1 ? input.length : nextRecord;
    const changes: Array<LogIndexEntry['changes'][number]> = [];
    let cursor = metadataEnd + 1;
    while (cursor < recordEnd && (input[cursor] === NUL || input[cursor] === 0x0a || input[cursor] === 0x0d)) {
      cursor += 1;
    }

    while (cursor < recordEnd) {
      const statusEnd = input.indexOf(NUL, cursor);
      if (statusEnd === -1 || statusEnd >= recordEnd) {
        throw parseError('parseLogIndex', cursor, 'missing NUL after change status');
      }
      const pathStart = statusEnd + 1;
      const pathEnd = input.indexOf(NUL, pathStart);
      if (pathEnd === -1 || pathEnd > recordEnd) {
        throw parseError('parseLogIndex', pathStart, 'missing NUL after change path');
      }
      const status = input.subarray(cursor, statusEnd).toString('utf8');
      const path = input.subarray(pathStart, pathEnd).toString('utf8');
      if (status.length === 0 || path.length === 0) {
        throw parseError('parseLogIndex', cursor, 'empty change status or path');
      }
      if (/^[RC]\d*$/.test(status)) {
        const renamedPathStart = pathEnd + 1;
        const renamedPathEnd = input.indexOf(NUL, renamedPathStart);
        if (renamedPathEnd === -1 || renamedPathEnd > recordEnd) {
          throw parseError('parseLogIndex', renamedPathStart, 'missing NUL after renamed path');
        }
        const renamedPath = input.subarray(renamedPathStart, renamedPathEnd).toString('utf8');
        if (renamedPath.length === 0) {
          throw parseError('parseLogIndex', renamedPathStart, 'empty renamed path');
        }
        changes.push({ status, path: renamedPath, originalPath: path });
        cursor = renamedPathEnd + 1;
      } else {
        changes.push({ status, path });
        cursor = pathEnd + 1;
      }
    }

    entries.push({ commit, changes });
    recordOffset = nextRecord;
  }

  return entries;
}

export function parseHistoryRecords(input: Buffer): CommitSummary[] {
  const commits: CommitSummary[] = [];
  let recordOffset = input.indexOf(RECORD_SEPARATOR);

  while (recordOffset !== -1) {
    const metadataEnd = input.indexOf(NUL, recordOffset + 1);
    if (metadataEnd === -1) {
      throw parseError('parseHistoryRecords', recordOffset, 'missing NUL after commit metadata');
    }
    commits.push(parseCommit(input.subarray(recordOffset + 1, metadataEnd), 'parseHistoryRecords', recordOffset));
    recordOffset = input.indexOf(RECORD_SEPARATOR, metadataEnd + 1);
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

function parseCommit(bytes: Buffer, parser: string, offset: number): CommitSummary {
  const fields = bytes.toString('utf8').split(String.fromCharCode(FIELD_SEPARATOR));
  if (fields.length !== 5) throw parseError(parser, offset, 'expected five commit fields');
  const [hash, authorName, authorEmail, authoredAtText, subject] = fields;
  const authoredAt = Number(authoredAtText);
  if (!hash || !authorName || !authorEmail || !authoredAtText || !subject || !Number.isSafeInteger(authoredAt)) {
    throw parseError(parser, offset, 'invalid mandatory commit field');
  }
  return { hash, authorName, authorEmail, authoredAt, subject };
}

function blameCommit(hash: string, fields: Map<string, string>, input: string, index: number): CommitSummary {
  const authorName = fields.get('author');
  const authorEmail = fields.get('author-mail')?.replace(/^<|>$/g, '');
  const authoredAtText = fields.get('author-time');
  const authoredAt = Number(authoredAtText);
  const subject = fields.get('summary');
  if (!authorName || !authorEmail || !authoredAtText || !subject || !Number.isSafeInteger(authoredAt)) {
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
