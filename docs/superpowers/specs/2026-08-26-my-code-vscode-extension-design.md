# My Code VS Code Extension Design

## Product intent

My Code is a zero-configuration desktop VS Code extension for developers who
work in large forked repositories. It answers a code-first question: “Which
parts of the code currently checked out were written by me, and how did those
parts get here?” It does not begin with a chronological Git log or require a
base commit.

The authoritative product requirements are in `PROJECT_GOAL.md`. If this
document and that file diverge, `PROJECT_GOAL.md` wins.

## Scope

The MVP will:

- read the global Git `user.name` and `user.email` automatically;
- inspect only commits reachable from the current `HEAD`;
- treat a commit as the user's when its author name or email exactly matches
  the normalized global Git identity;
- treat staged, unstaged, and untracked work as the current user's work;
- decorate files containing the user's current code in the normal Explorer;
- propagate file decorations to containing folders;
- add a `MY CODE` Explorer view with `CURRENT` and `PAST ACTIVITY` groups;
- mark the user's surviving lines in the editor gutter and overview ruler;
- show author commit metadata on hover;
- show identity-filtered file and line history on demand;
- open a selected historical change as a read-only VS Code diff;
- refresh after relevant editor, working-tree, and repository changes;
- avoid cloud services, GitHub accounts, and third-party Git extensions.

The MVP will not include a base-commit picker, a commit graph, a VS Code fork,
AI-versus-human attribution, cross-branch aggregation, or automatic change
stories.

## Supported environment

The first release targets desktop VS Code with Node.js extension-host support
and a locally available `git` executable. Web extension hosts are out of scope
because the product deliberately performs local Git analysis.

Every workspace folder is resolved independently to a Git worktree. Duplicate
folders resolving to the same worktree share one repository model. A folder
that is not inside a Git repository remains unaffected.

## User experience

On activation, My Code discovers repositories and identities without a setup
screen. Analysis runs in two phases:

1. Build or restore a lightweight index of the user's reachable commits and
   the paths those commits touched.
2. Blame candidate or working-tree files lazily, prioritizing the active editor
   and files for which Explorer requests decorations.

Explorer badges use these meanings:

- `A`: the current path was introduced in a matching user commit, or is an
  untracked file, and still exists;
- `M`: the file has at least one line attributed to the user or has a current
  staged/unstaged change;
- `◷`: shown in `PAST ACTIVITY` when the user touched the path in history but
  no user-authored line or current working change survives;
- a propagated dot/color on folders indicates a descendant with current user
  code.

If the user introduced a file and the path still exists, `A` takes precedence
over `M`, even if other authors later replaced its contents. This preserves the
literal product meaning that the user created the file.

The `MY CODE` view contains repository sections in multi-root workspaces. Each
repository has `CURRENT` and `PAST ACTIVITY` groups. File nodes open the current
file when available and expand to the user's commits for that path. History
nodes open a first-parent diff for the selected commit. Deleted historical
paths remain available under `PAST ACTIVITY`.

When a file is active, attributed ranges receive a gutter marker and overview
ruler color. Hover text contains author, date, short hash, and subject. It also
offers commands for the file history and the selected line's evolution. Line
history is computed only on request.

## Identity rules

Identity resolution executes:

```text
git config --global --get user.name
git config --global --get user.email
```

Names are trimmed and compared exactly after Unicode-aware lowercase
normalization. Emails are trimmed, stripped of optional angle brackets, and
compared case-insensitively. A commit matches when either non-empty configured
field matches the corresponding author field. Author identity, not committer
identity, is used.

If neither global field exists, analysis is paused for that repository and a
single actionable warning explains how to configure Git. The extension never
guesses from GitHub credentials or local commit history.

## Git analysis model

### Repository index

One structured `git log HEAD` process emits record- and field-delimited commit
metadata plus name-status entries. The parser produces:

- matching commit metadata keyed by hash;
- every path touched by a matching commit;
- whether a current path was added by a matching commit;
- per-path matching history in newest-first order.

Records from non-matching authors are discarded after parsing. Traversal is
limited to ancestors of the checked-out `HEAD`; unrelated branch tips are never
queried.

### Working tree

`git status --porcelain=v2 -z --untracked-files=all` supplies staged,
unstaged, renamed, deleted, and untracked paths. Any current working-tree path
is added to the candidate set. Untracked files are wholly attributed to the
current user. Deleted paths are history-only.

### Current line ownership

Tracked candidates use `git blame --line-porcelain -- <path>` against the
working tree. A line is the user's when its author matches the resolved
identity or its blame hash is all zeroes (`Not Committed Yet`). Contiguous
matching lines are collapsed into editor ranges.

Blame failures caused by a disappearing or binary file produce an unknown or
history-only state, never a false current attribution. Untracked text files are
represented as one full-document range. Binary files can receive file badges
but never line decorations.

### History and diffs

File history uses reachable `HEAD` history for the selected path and filters by
the same identity. Line history uses `git log -L` only after an explicit user
action. A custom read-only document scheme resolves `revision:path` through
`git show`, allowing `vscode.diff` to compare a commit with its first parent.
Root commits and absent sides are represented by an empty virtual document.

## Architecture

The implementation is divided into small, testable units:

- `GitRunner`: executes `git` with argument arrays, bounded output, cancellation,
  normalized errors, and no shell interpolation.
- `IdentityResolver`: loads and normalizes the global Git identity.
- `GitParsers`: pure parsers for log, status, blame, and line-history output.
- `RepositoryAnalyzer`: owns the two-phase index, working-tree overlay,
  classification, caches, and refresh generation for one repository.
- `RepositoryRegistry`: discovers workspace repositories, de-duplicates roots,
  and manages analyzer lifetimes.
- `MyCodeDecorationProvider`: maps repository classifications to normal Explorer
  decorations and lazily requests unresolved candidates.
- `MyCodeTreeProvider`: exposes current files, past activity, and per-file
  history in the Explorer.
- `EditorOwnershipController`: schedules blame for visible editors and owns
  decoration ranges and hover content.
- `HistoryController`: provides file/line history commands and virtual Git
  documents for diffs.
- `RefreshController`: debounces editor events, observes Git metadata, and
  performs inexpensive repository fingerprint checks while VS Code is active.

VS Code-facing units depend on repository interfaces rather than Git process
details. Parser and analyzer behavior can therefore be tested without loading
an Extension Development Host.

## Caching and performance

The cache has three layers:

1. An in-memory repository index keyed by repository root, `HEAD`, and identity.
2. An LRU blame cache keyed by `HEAD`, path, and working-file fingerprint.
3. A metadata-only disk cache under the extension storage directory containing
   the reachable-user index. It stores paths and commit metadata, never source
   contents.

The active editor and Explorer decoration requests enter a high-priority blame
queue. Remaining candidates are processed in a bounded background queue. At
most four Git subprocesses run per repository, and only one repository-index
scan runs at a time. Refresh generations make stale async results harmless.

`HEAD` or identity changes invalidate the repository index and all blame data.
A working-tree fingerprint change invalidates only affected path state when the
changed paths are known; otherwise it clears blame entries but keeps the commit
index. Repository scans expose progress in the status bar only when they take
long enough to be noticeable.

## Refresh behavior

Refreshes are triggered by:

- workspace folder changes;
- document saves, creates, deletes, and renames;
- active or visible editor changes;
- observed `HEAD`, index, and refs changes when available;
- a low-frequency repository fingerprint check while the window is focused;
- the explicit `My Code: Refresh` command.

Events are debounced and coalesced. A checkout, commit, rebase, or identity
change causes a full index refresh; ordinary file saves update only the
affected path before the background index catches up.

## Error handling

Expected states are communicated without modal error loops:

- Git missing: one warning with the executable failure and a retry command.
- No global identity: one warning with the two required `git config` commands.
- Not a repository or unborn `HEAD`: no decorations; `MY CODE` explains the
  current state.
- Git command cancellation or superseded generation: silent discard.
- Parse or command failure: log details to a dedicated output channel and keep
  the last valid snapshot when safe.

All Git commands use `execFile`-style argument arrays. Paths, names, and commit
subjects are never interpolated into a shell command.

## Testing

Testing has three layers:

- Pure unit tests for identity matching, delimiter-safe log parsing, porcelain
  status parsing, blame range collapsing, and file classification.
- Git integration tests that create temporary repositories with multiple
  authors, commits, staged/unstaged/untracked files, overwritten lines, and
  reverted history. These assert behavior against the installed Git binary.
- Extension smoke checks for activation metadata, contribution IDs, TypeScript
  compilation, bundling, and VSIX packaging. A lightweight Extension Host smoke
  test is included when the local VS Code test runtime is available.

The core acceptance fixture proves that another author's files are excluded,
the user's added and modified files are current, overwritten or reverted paths
move to past activity, working changes are attributed to the user, and only
reachable `HEAD` history is used.

## Delivery

The repository will contain source, tests, build configuration, a user-facing
README, development instructions, and an installable `.vsix`. The initial
publisher identifier is local-only and can be changed before Marketplace
publication.
