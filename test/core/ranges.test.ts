import { describe, expect, it } from 'vitest';

import { collapseOwnedLines } from '../../src/core/ranges.js';

describe('collapseOwnedLines', () => {
  it('collapses adjacent zero-based lines', () => {
    const owned = (line: number) => ({ line, commit: undefined, uncommitted: true });

    expect(collapseOwnedLines([1, 2, 3, 7, 9, 10].map(owned))).toEqual([
      { start: 1, endExclusive: 4, commit: undefined, uncommitted: true },
      { start: 7, endExclusive: 8, commit: undefined, uncommitted: true },
      { start: 9, endExclusive: 11, commit: undefined, uncommitted: true }
    ]);
  });

  it('deduplicates and separates adjacent lines with different attribution', () => {
    const commit = {
      hash: 'abc', authorName: 'Me', authorEmail: 'me@example.com', authoredAt: 1, subject: 'work'
    };

    expect(collapseOwnedLines([
      { line: 3, commit, uncommitted: false },
      { line: 1, commit: undefined, uncommitted: true },
      { line: 2, commit: undefined, uncommitted: true },
      { line: 1, commit: undefined, uncommitted: true },
      { line: 4, commit, uncommitted: false }
    ])).toEqual([
      { start: 1, endExclusive: 3, commit: undefined, uncommitted: true },
      { start: 3, endExclusive: 5, commit, uncommitted: false }
    ]);
  });
});
