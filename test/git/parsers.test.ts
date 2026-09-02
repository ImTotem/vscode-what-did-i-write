import { describe, expect, it } from 'vitest';

import {
  GitParseError,
  parseHistoryRecords,
  parseLinePorcelainBlame,
  parseLogIndex,
  parsePorcelainV2Status
} from '../../src/git/parsers.js';
import * as parserModule from '../../src/git/parsers.js';

describe('Git parsers', () => {
  it('parses NUL-delimited numstat records and ignores binary line counts', () => {
    const parse = (parserModule as unknown as {
      parseNumStat?: (input: Buffer) => readonly unknown[];
    }).parseNumStat;

    expect(parse).toBeTypeOf('function');
    expect(parse?.(Buffer.from('10\t4\tsrc/a file.ts\x00-\t-\tassets/data.bin\x003\t0\t한글.ts\x00'))).toEqual([
      { additions: 10, deletions: 4, path: 'src/a file.ts' },
      { additions: 3, deletions: 0, path: '한글.ts' }
    ]);
  });

  it('groups one NUL-delimited numstat log by commit hash', () => {
    const parse = (parserModule as unknown as {
      parseCommitNumStats?: (input: Buffer) => ReadonlyMap<string, readonly unknown[]>;
    }).parseCommitNumStats;
    const raw = [
      '', 'aaa', '', '\n2\t1\tsrc/a.ts', '',
      'bbb', '', '\n3\t0\tsrc/b.ts', '\n-\t-\tassets/data.bin', ''
    ].join('\0');

    expect(parse).toBeTypeOf('function');
    expect([...(parse?.(Buffer.from(raw)) ?? [])]).toEqual([
      ['aaa', [{ additions: 2, deletions: 1, path: 'src/a.ts' }]],
      ['bbb', [{ additions: 3, deletions: 0, path: 'src/b.ts' }]]
    ]);
  });

  it('parses matching commit metadata and NUL-delimited name status', () => {
    const raw = '\x00abc\x00Alice\x00alice@example.com\x001700000000\x00제목\x00\x00A\x00src/a file.ts\x00';

    expect(parseLogIndex(Buffer.from(raw))).toEqual([{
      commit: {
        hash: 'abc', authorName: 'Alice', authorEmail: 'alice@example.com',
        authoredAt: 1700000000, subject: '제목'
      },
      changes: [{ status: 'A', path: 'src/a file.ts' }]
    }]);
  });

  it('accepts the double-NUL framing emitted by the prescribed log command', () => {
    const raw = '\x00abc\x00Alice\x00alice@example.com\x001700000000\x00subject\x00\x00A\x00src/a file.ts\x00';

    expect(parseLogIndex(Buffer.from(raw))).toEqual([{
      commit: {
        hash: 'abc', authorName: 'Alice', authorEmail: 'alice@example.com',
        authoredAt: 1700000000, subject: 'subject'
      },
      changes: [{ status: 'A', path: 'src/a file.ts' }]
    }]);
  });

  it('keeps tabs and Unicode paths in status records and rename pairs', () => {
    const raw = [
      '1 M. N... 100644 100644 100644 abcdef0 abcdef0 src/a\tfile.ts',
      '2 R. N... 100644 100644 100644 abcdef0 abcdef0 R100 새 이름.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 abc abc def conflict.ts',
      '? untracked file.ts',
      '! ignored.ts',
      ''
    ].join('\x00');

    expect(parsePorcelainV2Status(Buffer.from(raw))).toEqual([
      { status: 'M.', path: 'src/a\tfile.ts' },
      { status: 'R.', path: '새 이름.ts', originalPath: 'old name.ts' },
      { status: 'UU', path: 'conflict.ts' },
      { status: '?', path: 'untracked file.ts' },
      { status: '!', path: 'ignored.ts' }
    ]);
  });

  it('recognizes uncommitted blame lines', () => {
    const raw = `${'0'.repeat(40)} 1 1 1\nauthor Not Committed Yet\nauthor-mail <not.committed.yet>\n\tchanged\n`;

    expect(parseLinePorcelainBlame(raw)[0]?.uncommitted).toBe(true);
  });

  it('parses committed blame metadata into zero-based line attribution', () => {
    const raw = 'abcdef 3 8 1\nauthor Alice\nauthor-mail <alice@example.com>\nauthor-time 1700000000\nsummary 제목\nfilename src/a file.ts\n\tline\n';

    expect(parseLinePorcelainBlame(raw)).toEqual([{
      line: 7,
      uncommitted: false,
      commit: {
        hash: 'abcdef', authorName: 'Alice', authorEmail: 'alice@example.com',
        authoredAt: 1700000000, subject: '제목'
      }
    }]);
  });

  it('parses blame continuation headers that omit the group size', () => {
    const raw = [
      'abcdef 1 1 2',
      'author Alice',
      'author-mail <alice@example.com>',
      'author-time 1700000000',
      'summary first',
      'filename src/a.ts',
      '\tfirst',
      'abcdef 2 2',
      'author Alice',
      'author-mail <alice@example.com>',
      'author-time 1700000000',
      'summary first',
      'filename src/a.ts',
      '\tsecond',
      ''
    ].join('\n');

    expect(parseLinePorcelainBlame(raw).map((line) => line.line)).toEqual([0, 1]);
  });

  it('parses record-separated history metadata without path records', () => {
    const raw = '\x00aaa\x00Alice\x00alice@example.com\x001700000000\x00first\x00\x00\x00bbb\x00Bob\x00bob@example.com\x001700000001\x00second\x00\x00';

    expect(parseHistoryRecords(Buffer.from(raw))).toEqual([
      { hash: 'aaa', authorName: 'Alice', authorEmail: 'alice@example.com', authoredAt: 1700000000, subject: 'first' },
      { hash: 'bbb', authorName: 'Bob', authorEmail: 'bob@example.com', authoredAt: 1700000001, subject: 'second' }
    ]);
  });

  it('parses NUL-framed fixed fields with control bytes, empty subjects, and literal backslashes', () => {
    const firstHash = 'a'.repeat(40);
    const secondHash = 'b'.repeat(40);
    const raw = Buffer.from([
      '', firstHash, 'Alice', 'alice@example.com', '1700000000', 'subject\x1eand\x1fcontrols', '',
      'A', 'src/control\x1e\x1f.ts',
      '', secondHash, 'Alice', 'alice@example.com', '1700000001', '', '',
      'M', 'src/literal\\backslash.ts', ''
    ].join('\x00'));

    expect(parseLogIndex(raw)).toEqual([
      {
        commit: {
          hash: firstHash,
          authorName: 'Alice',
          authorEmail: 'alice@example.com',
          authoredAt: 1700000000,
          subject: 'subject\x1eand\x1fcontrols'
        },
        changes: [{ status: 'A', path: 'src/control\x1e\x1f.ts' }]
      },
      {
        commit: {
          hash: secondHash,
          authorName: 'Alice',
          authorEmail: 'alice@example.com',
          authoredAt: 1700000001,
          subject: ''
        },
        changes: [{ status: 'M', path: 'src/literal\\backslash.ts' }]
      }
    ]);
  });

  it('parses NUL-framed history with control bytes and a legal empty subject', () => {
    const firstHash = 'c'.repeat(40);
    const secondHash = 'd'.repeat(40);
    const raw = Buffer.from([
      '', firstHash, 'Alice', 'alice@example.com', '1700000000', 'subject\x1e\x1f',
      '', secondHash, 'Alice', 'alice@example.com', '1700000001', '', ''
    ].join('\x00'));

    expect(parseHistoryRecords(raw)).toEqual([
      {
        hash: firstHash, authorName: 'Alice', authorEmail: 'alice@example.com',
        authoredAt: 1700000000, subject: 'subject\x1e\x1f'
      },
      {
        hash: secondHash, authorName: 'Alice', authorEmail: 'alice@example.com',
        authoredAt: 1700000001, subject: ''
      }
    ]);
  });

  it('reports a parser name and byte offset for malformed mandatory commit data', () => {
    expect(() => parseHistoryRecords(Buffer.from('\x00abc\x00Alice\x00alice@example.com\x00not-a-time\x00subject\x00\x00')))
      .toThrow(GitParseError);
    expect(() => parseHistoryRecords(Buffer.from('\x00abc\x00Alice\x00alice@example.com\x00not-a-time\x00subject\x00\x00')))
      .toThrow(/parseHistoryRecords.*byte offset 0/);
  });

  it('rejects unterminated status records and malformed status prefixes', () => {
    expect(() => parsePorcelainV2Status(Buffer.from('? missing-terminator'))).toThrow(GitParseError);
    expect(() => parsePorcelainV2Status(Buffer.from('?missing-space\x00'))).toThrow(GitParseError);
    expect(() => parsePorcelainV2Status(Buffer.from('!missing-space\x00'))).toThrow(GitParseError);
    expect(() => parsePorcelainV2Status(Buffer.from('2 R. N... 100644 100644 100644 abc abc R100 renamed.ts\x00')))
      .toThrow(GitParseError);
  });

  it('rejects empty mandatory commit and blame timestamps', () => {
    expect(() => parseHistoryRecords(Buffer.from('\x00abc\x00Alice\x00alice@example.com\x00\x00subject\x00\x00')))
      .toThrow(GitParseError);
    expect(() => parseLinePorcelainBlame('abcdef 1 1 1\nauthor Alice\nauthor-mail <alice@example.com>\nauthor-time \nsummary subject\n\tline\n'))
      .toThrow(GitParseError);
  });
});
