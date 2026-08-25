import { describe, expect, it } from 'vitest';

import {
  GitParseError,
  parseHistoryRecords,
  parseLinePorcelainBlame,
  parseLogIndex,
  parsePorcelainV2Status
} from '../../src/git/parsers.js';

describe('Git parsers', () => {
  it('parses matching commit metadata and NUL-delimited name status', () => {
    const raw = '\x1eabc\x1fAlice\x1falice@example.com\x1f1700000000\x1f제목\x00A\x00src/a file.ts\x00';

    expect(parseLogIndex(Buffer.from(raw))).toEqual([{
      commit: {
        hash: 'abc', authorName: 'Alice', authorEmail: 'alice@example.com',
        authoredAt: 1700000000, subject: '제목'
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
    const raw = '\x1eaaa\x1fAlice\x1falice@example.com\x1f1700000000\x1ffirst\x00\x1ebbb\x1fBob\x1fbob@example.com\x1f1700000001\x1fsecond\x00';

    expect(parseHistoryRecords(Buffer.from(raw))).toEqual([
      { hash: 'aaa', authorName: 'Alice', authorEmail: 'alice@example.com', authoredAt: 1700000000, subject: 'first' },
      { hash: 'bbb', authorName: 'Bob', authorEmail: 'bob@example.com', authoredAt: 1700000001, subject: 'second' }
    ]);
  });

  it('reports a parser name and byte offset for malformed mandatory commit data', () => {
    expect(() => parseHistoryRecords(Buffer.from('\x1eabc\x1fAlice\x1falice@example.com\x1fnot-a-time\x1fsubject\x00')))
      .toThrow(GitParseError);
    expect(() => parseHistoryRecords(Buffer.from('\x1eabc\x1fAlice\x1falice@example.com\x1fnot-a-time\x1fsubject\x00')))
      .toThrow(/parseHistoryRecords.*byte offset 0/);
  });
});
