import type { CommitSummary, OwnedLine, OwnedRange } from './model.js';

function sameCommit(left: CommitSummary | undefined, right: CommitSummary | undefined): boolean {
  return left?.hash === right?.hash
    && left?.authorName === right?.authorName
    && left?.authorEmail === right?.authorEmail
    && left?.authoredAt === right?.authoredAt
    && left?.subject === right?.subject;
}

export function collapseOwnedLines(lines: readonly OwnedLine[]): OwnedRange[] {
  const sorted = [...lines].sort((left, right) => left.line - right.line);
  const unique = sorted.filter((line, index) => index === 0 || line.line !== sorted[index - 1]?.line);
  const ranges: OwnedRange[] = [];

  for (const line of unique) {
    const previous = ranges.at(-1);
    if (
      previous !== undefined
      && line.line === previous.endExclusive
      && line.uncommitted === previous.uncommitted
      && sameCommit(line.commit, previous.commit)
    ) {
      ranges[ranges.length - 1] = { ...previous, endExclusive: line.line + 1 };
    } else {
      ranges.push({
        start: line.line,
        endExclusive: line.line + 1,
        commit: line.commit,
        uncommitted: line.uncommitted
      });
    }
  }

  return ranges;
}
