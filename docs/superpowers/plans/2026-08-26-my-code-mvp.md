# My Code MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, test, document, and package a zero-configuration desktop VS Code extension that identifies the current Git user's reachable files, lines, and contextual history.

**Architecture:** A shell-free Git process layer feeds pure delimiter-safe parsers and one analyzer per repository. The analyzer builds a reachable-user path index first, overlays working-tree state, and lazily computes blame ranges; thin VS Code adapters render Explorer decorations, a `MY CODE` tree, editor markers, hovers, history, and diffs.

**Tech Stack:** TypeScript, Node.js 20+, VS Code Extension API `^1.96.0`, esbuild, Vitest, the local Git CLI, and `@vscode/vsce`.

**Spec:** `docs/superpowers/specs/2026-08-26-my-code-vscode-extension-design.md`

## Global Constraints

- Target desktop VS Code only; do not declare web extension support.
- Execute Git with argument arrays and `shell: false`; never interpolate paths or identities into a shell command.
- Read only global `user.name` and `user.email`; match reachable `HEAD` authors by normalized name OR email.
- Treat staged, unstaged, and untracked content as the current user's work.
- Do not add a base commit, commit graph, external service, GitHub account, or third-party extension dependency.
- Keep source contents out of persistent caches.
- Bound Git concurrency to four subprocesses per repository and one index scan per repository.
- `PROJECT_GOAL.md` remains authoritative if requirements conflict.

---

## Planned file structure

```text
package.json                         Extension manifest, commands, views, build scripts
tsconfig.json                        Strict TypeScript configuration
esbuild.mjs                          Production extension bundle
vitest.config.ts                     Unit and Git integration test configuration
.vscodeignore                        VSIX inclusion rules
.gitignore                           Build, coverage, cache, and VSIX ignores
README.md                            User installation, behavior, badges, commands
CHANGELOG.md                         0.1.0 MVP notes
src/extension.ts                     Composition root and activation/deactivation
src/core/model.ts                    Shared domain types and file classifications
src/core/identity.ts                 Identity normalization and matching
src/core/ranges.ts                   Owned-line range collapsing
src/git/gitRunner.ts                 Safe, cancellable, bounded Git subprocesses
src/git/parsers.ts                   Log, status, blame, and history parsers
src/git/repository.ts                Repository-specific Git operations
src/analysis/cacheStore.ts           Metadata-only disk cache
src/analysis/repositoryAnalyzer.ts   Index, overlay, lazy blame, snapshots, generations
src/extension/repositoryRegistry.ts  Workspace discovery and analyzer lifecycle
src/ui/fileDecorations.ts            Normal Explorer A/M and folder propagation
src/ui/myCodeTree.ts                 CURRENT/PAST tree and file history nodes
src/ui/editorOwnership.ts            Gutter, ruler, background, and hover decorations
src/ui/gitContentProvider.ts         Read-only revision:path virtual documents
src/ui/historyController.ts          File/line history commands and diff opening
src/ui/refreshController.ts          Debounced events and focused-window polling
src/ui/statusController.ts           Status bar and output channel messages
test/helpers/gitFixture.ts           Temporary multi-author repository builder
test/core/identity.test.ts           Identity behavior
test/core/ranges.test.ts             Range collapsing behavior
test/git/parsers.test.ts             Delimited output parser behavior
test/git/repository.integration.test.ts Real Git command behavior
test/analysis/repositoryAnalyzer.integration.test.ts End-to-end classification
test/manifest.test.ts                Contribution and packaging invariants
```

### Task 1: Project foundation and domain rules

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.mjs`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.vscodeignore`
- Create: `src/core/model.ts`
- Create: `src/core/identity.ts`
- Create: `src/core/ranges.ts`
- Test: `test/core/identity.test.ts`
- Test: `test/core/ranges.test.ts`

**Interfaces:**
- Produces: `GitIdentity`, `CommitSummary`, `OwnedLine`, `OwnedRange`, `FileKind`, `FileRecord`, `RepositorySnapshot`.
- Produces: `normalizeIdentityPart(value: string): string`, `normalizeEmail(value: string): string`, `matchesIdentity(identity: GitIdentity, authorName: string, authorEmail: string): boolean`.
- Produces: `collapseOwnedLines(lines: readonly OwnedLine[]): OwnedRange[]`, where line numbers are zero-based and adjacent lines collapse only when their attribution is equal.

- [ ] **Step 1: Add the manifest and strict build/test configuration**

Use `main: "./dist/extension.js"`, `engines.vscode: "^1.96.0"`, `extensionKind: ["workspace"]`, `activationEvents: ["onStartupFinished"]`, and scripts `check`, `build`, `watch`, `test`, `test:run`, and `package`. Bundle `src/extension.ts` for Node with esbuild and keep `vscode` external.

- [ ] **Step 2: Write failing identity and range tests**

```ts
it('matches either configured author field after normalization', () => {
  const identity = { name: '박성빈', email: 'SungBin@Example.com' };
  expect(matchesIdentity(identity, '박성빈', 'other@example.com')).toBe(true);
  expect(matchesIdentity(identity, 'Other', '<sungbin@example.com>')).toBe(true);
  expect(matchesIdentity(identity, 'Other', 'other@example.com')).toBe(false);
});

it('collapses adjacent zero-based lines', () => {
  const owned = (line: number) => ({ line, commit: undefined, uncommitted: true });
  expect(collapseOwnedLines([1, 2, 3, 7, 9, 10].map(owned))).toEqual([
    { start: 1, endExclusive: 4, commit: undefined, uncommitted: true },
    { start: 7, endExclusive: 8, commit: undefined, uncommitted: true },
    { start: 9, endExclusive: 11, commit: undefined, uncommitted: true },
  ]);
});
```

- [ ] **Step 3: Run the focused tests and verify the red state**

Run: `npm test -- --run test/core/identity.test.ts test/core/ranges.test.ts`

Expected: failure because the core modules do not exist.

- [ ] **Step 4: Implement the domain types, normalization, matching, and range collapse**

```ts
export interface GitIdentity { readonly name: string; readonly email: string }
export type FileKind = 'added' | 'modified' | 'past';
export interface CommitSummary {
  readonly hash: string; readonly authorName: string; readonly authorEmail: string;
  readonly authoredAt: number; readonly subject: string;
}
export interface OwnedLine {
  readonly line: number; readonly commit?: CommitSummary; readonly uncommitted: boolean;
}
export interface OwnedRange {
  readonly start: number; readonly endExclusive: number;
  readonly commit?: CommitSummary; readonly uncommitted: boolean;
}
export interface FileRecord {
  readonly relativePath: string; readonly kind: FileKind; readonly exists: boolean;
  readonly working: boolean; readonly binary: boolean; readonly ranges: readonly OwnedRange[];
  readonly history: readonly CommitSummary[];
}
export interface RepositorySnapshot {
  readonly root: string; readonly head: string; readonly identity: GitIdentity;
  readonly files: readonly FileRecord[]; readonly scanning: boolean;
  readonly generatedAt: number;
}
```

Deduplicate and sort line inputs before collapsing. Normalize names with `trim().normalize('NFKC').toLocaleLowerCase()` and emails with trimming, optional angle-bracket removal, NFKC, and lowercase.

- [ ] **Step 5: Run checks and commit the foundation**

Run: `npm run check`

Run: `npm test -- --run test/core/identity.test.ts test/core/ranges.test.ts`

Expected: both commands pass.

Commit: `git commit -am "chore: scaffold My Code extension"` after staging all Task 1 files.

### Task 2: Safe Git execution and delimiter-safe parsers

**Files:**
- Create: `src/git/gitRunner.ts`
- Create: `src/git/parsers.ts`
- Test: `test/git/parsers.test.ts`

**Interfaces:**
- Consumes: `GitIdentity`, `CommitSummary`, `OwnedRange` from `src/core/model.ts`.
- Produces: `GitRunner.run(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<GitResult>`.
- Produces: `parseLogIndex`, `parsePorcelainV2Status`, `parseLinePorcelainBlame`, and `parseHistoryRecords`.
- Produces: `LogIndexEntry`, `WorkingChange`, and `BlameLine` parser records.

- [ ] **Step 1: Write parser fixtures that include spaces, tabs, Unicode, rename pairs, and zero hashes**

```ts
it('parses matching commit metadata and NUL-delimited name status', () => {
  const raw = '\x1eabc\x1fAlice\x1falice@example.com\x1f1700000000\x1f제목\x00A\x00src/a file.ts\x00';
  expect(parseLogIndex(Buffer.from(raw))).toEqual([{ commit: {
    hash: 'abc', authorName: 'Alice', authorEmail: 'alice@example.com',
    authoredAt: 1700000000, subject: '제목'
  }, changes: [{ status: 'A', path: 'src/a file.ts' }] }]);
});

it('recognizes uncommitted blame lines', () => {
  const raw = `${'0'.repeat(40)} 1 1 1\nauthor Not Committed Yet\nauthor-mail <not.committed.yet>\n\tchanged\n`;
  expect(parseLinePorcelainBlame(raw)[0]?.uncommitted).toBe(true);
});
```

- [ ] **Step 2: Verify parser tests fail**

Run: `npm test -- --run test/git/parsers.test.ts`

Expected: failure because `src/git/parsers.ts` is absent.

- [ ] **Step 3: Implement parsers as pure functions over Buffer/string input**

Use record separator `0x1e`, field separator `0x1f`, and NUL path separators for log output. Parse porcelain-v2 record types `1`, `2`, `u`, `?`, and `!`; for type `2`, consume the following NUL field as the original path. Treat `/^0{40,64}$/` blame hashes as uncommitted. Reject malformed mandatory commit fields with a typed `GitParseError` that names the parser and byte offset.

- [ ] **Step 4: Implement GitRunner with cancellation, output limits, and a four-slot semaphore**

```ts
export interface GitRunOptions {
  readonly signal?: AbortSignal;
  readonly maxBufferBytes?: number;
  readonly allowExitCodes?: readonly number[];
}
export interface GitResult { readonly stdout: Buffer; readonly stderr: string; readonly exitCode: number }
```

Use `spawn('git', args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })`. Kill an active child when the signal aborts, default to a 64 MiB stdout limit, and include sanitized arguments and stderr in `GitCommandError` without source contents.

- [ ] **Step 5: Run tests and commit**

Run: `npm run check`

Run: `npm test -- --run test/git/parsers.test.ts`

Expected: pass.

Commit: `git commit -am "feat: add safe Git execution and parsers"` after staging Task 2 files.

### Task 3: Repository Git operations with real fixtures

**Files:**
- Create: `src/git/repository.ts`
- Create: `test/helpers/gitFixture.ts`
- Test: `test/git/repository.integration.test.ts`

**Interfaces:**
- Consumes: `GitRunner` and all parser functions.
- Produces: `GitRepository.discover`, `getGlobalIdentity`, `getHead`, `getUserIndex`, `getWorkingChanges`, `blame`, `getFileHistory`, `getLineHistory`, `showFile`, and `getFingerprint`.
- Produces: `createGitFixture(): Promise<GitFixture>` with safe argument-array helpers for test setup.

- [ ] **Step 1: Write a multi-author repository integration test**

Create a temporary repository with local test identity `Alice`, commit an upstream file, switch identity to `Me`, add one file and modify one line, switch back to `Alice`, overwrite the user's line, and create an unrelated branch commit not reachable from the final `HEAD`. Assert:

```ts
const repository = await GitRepository.discover(fixture.root, runner);
expect(await repository.getGlobalIdentity()).toEqual(globalIdentityFromFixture);
expect((await repository.getUserIndex(globalIdentityFromFixture)).commits.map(c => c.subject))
  .not.toContain('unreachable work');
expect(await repository.getWorkingChanges()).toEqual([]);
```

The fixture must save and restore the process's original global Git name/email, or instead pass an isolated `HOME`/`USERPROFILE` and `GIT_CONFIG_GLOBAL` to every fixture command so the developer's real configuration is never modified. Use the isolated-environment approach.

- [ ] **Step 2: Run the integration test and verify failure**

Run: `npm test -- --run test/git/repository.integration.test.ts`

Expected: failure because `GitRepository` is absent.

- [ ] **Step 3: Implement repository discovery and operations**

Use these exact Git shapes:

```text
git rev-parse --show-toplevel
git rev-parse --verify HEAD
git config --global --get user.name
git config --global --get user.email
git log HEAD --format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s%x00 --name-status -z --no-renames
git status --porcelain=v2 -z --untracked-files=all
git blame --line-porcelain -- path
git log HEAD --follow --format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s%x00 -- path
git log HEAD -L line,line:path --format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s%x00
git show revision:path
```

Pass `--literal-pathspecs` immediately after `git` for path-bearing commands and pass `--` before paths whenever supported.

- [ ] **Step 4: Add staged, unstaged, untracked, Unicode-path, and binary assertions**

Assert status parsing preserves each path, blame returns both matching and non-matching authors, untracked files are reported, `showFile` returns bytes without decoding, and absent revisions return `undefined` only for the expected Git exit code.

- [ ] **Step 5: Run and commit**

Run: `npm test -- --run test/git/repository.integration.test.ts`

Run: `npm run check`

Expected: pass.

Commit: `git commit -am "feat: add repository Git operations"` after staging Task 3 files.

### Task 4: Two-phase analyzer, classification, and persistent index cache

**Files:**
- Create: `src/analysis/cacheStore.ts`
- Create: `src/analysis/repositoryAnalyzer.ts`
- Test: `test/analysis/repositoryAnalyzer.integration.test.ts`

**Interfaces:**
- Consumes: `GitRepository`, `matchesIdentity`, `collapseOwnedLines`, and domain models.
- Produces: `RepositoryAnalyzer.initialize()`, `refresh(reason, paths?)`, `ensureFile(relativePath, priority)`, `getSnapshot()`, `getFile(relativePath)`, and event `onDidChange`.
- Produces: `CacheStore.loadIndex(key)`, `saveIndex(key, value)`, and `clearRepository(repoRoot)`.

- [ ] **Step 1: Write the acceptance classification test before analyzer code**

Build a fixture with:

- `mine-added.ts`: added by the user and still present;
- `mine-survives.ts`: one user line still blamed to the user;
- `mine-overwritten.ts`: touched by the user, then entirely replaced by another author;
- `mine-reverted.ts`: user commit reverted so no user line survives;
- `other-only.ts`: never touched by the user;
- `working.ts`: modified but uncommitted by the fixture's current user;
- `new-untracked.ts`: untracked.

Assert, after `initialize()` and `ensureFile()` calls:

```ts
expect(kind('mine-added.ts')).toBe('added');
expect(kind('mine-survives.ts')).toBe('modified');
expect(kind('mine-overwritten.ts')).toBe('past');
expect(kind('mine-reverted.ts')).toBe('past');
expect(find('other-only.ts')).toBeUndefined();
expect(kind('working.ts')).toBe('modified');
expect(kind('new-untracked.ts')).toBe('added');
```

- [ ] **Step 2: Run the analyzer acceptance test and verify failure**

Run: `npm test -- --run test/analysis/repositoryAnalyzer.integration.test.ts`

Expected: failure because analyzer and cache do not exist.

- [ ] **Step 3: Implement index construction and working-tree overlay**

Filter parsed commits with `matchesIdentity`. Build one candidate per matching name-status path. An `A` status from a matching commit sets `introducedByUser`. Overlay working changes, mark untracked paths as introduced/current, and retain deleted user paths as past. Publish an initial snapshot before any background blame finishes.

- [ ] **Step 4: Implement lazy blame and deterministic classification**

```ts
function classify(input: {
  exists: boolean; introducedByUser: boolean; working: boolean;
  hasOwnedLines: boolean; touchedByUser: boolean;
}): FileKind | undefined {
  if (!input.exists) return input.touchedByUser ? 'past' : undefined;
  if (input.introducedByUser) return 'added';
  if (input.working || input.hasOwnedLines) return 'modified';
  return input.touchedByUser ? 'past' : undefined;
}
```

Collapse matching or zero-hash blame lines into ranges. Detect binary files by a NUL byte in the first 8 KiB or the expected blame failure and leave their ranges empty.

- [ ] **Step 5: Implement generation safety, priority queue, and metadata cache**

Use monotonically increasing generations; every async write checks the generation captured at start. The priority queue orders `active-editor`, `explorer`, then `background` and never runs more than four jobs. Persist only matching commit metadata, touched paths, introduced flags, and the cache key `{ rootHash, head, normalizedIdentity }` as JSON under `ExtensionContext.storageUri`.

- [ ] **Step 6: Prove cache reuse and invalidation**

Add tests that initialize twice with the same `HEAD` and identity and assert the second analyzer restores the index without executing `git log`. Change `HEAD` and assert a new log scan. Change only a working file and assert the commit index remains reusable while its blame entry is invalidated.

- [ ] **Step 7: Run and commit**

Run: `npm test -- --run test/analysis/repositoryAnalyzer.integration.test.ts`

Run: `npm run check`

Expected: pass.

Commit: `git commit -am "feat: classify current and past user code"` after staging Task 4 files.

### Task 5: Extension activation, repository registry, and refresh lifecycle

**Files:**
- Create: `src/extension/repositoryRegistry.ts`
- Create: `src/ui/refreshController.ts`
- Create: `src/ui/statusController.ts`
- Create: `src/extension.ts`
- Modify: `package.json`
- Test: `test/manifest.test.ts`

**Interfaces:**
- Consumes: `GitRunner`, `GitRepository`, `RepositoryAnalyzer`, and `CacheStore`.
- Produces: `RepositoryRegistry.start()`, `findByUri(uri)`, `repositories`, and `onDidChange`.
- Produces: `RefreshController` that accepts save/create/delete/rename events and focused-window fingerprint ticks.
- Produces: VS Code commands `myCode.refresh`, `myCode.showOutput`, and `myCode.retryIdentity`.

- [ ] **Step 1: Write manifest invariant tests**

```ts
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
expect(manifest.main).toBe('./dist/extension.js');
expect(manifest.extensionKind).toContain('workspace');
expect(manifest.activationEvents).toContain('onStartupFinished');
expect(manifest.contributes.commands.map((c: { command: string }) => c.command))
  .toContain('myCode.refresh');
```

- [ ] **Step 2: Verify the manifest test fails on missing contributions**

Run: `npm test -- --run test/manifest.test.ts`

Expected: failure because the command and activation metadata are incomplete.

- [ ] **Step 3: Implement repository registry and activation composition**

Discover each workspace folder with `GitRepository.discover`, de-duplicate by normalized repository root, create one analyzer, and initialize analyzers without blocking extension activation. Dispose analyzers when their final workspace folder disappears. `activate` owns a `My Code` output channel and registers every disposable through `context.subscriptions`.

- [ ] **Step 4: Implement refresh events and repository fingerprints**

Debounce path refreshes by 250 ms. On saves, creates, deletes, and renames, refresh only affected repository paths. While the window is focused, check fingerprints every 10 seconds; stop the timer while unfocused. A changed `HEAD` triggers full refresh; a changed status fingerprint refreshes working paths; an explicit command always performs a full refresh.

- [ ] **Step 5: Implement non-repeating status and warnings**

Status text is `$(account) My Code: N files`, `$(sync~spin) My Code: Scanning`, or `$(warning) My Code: Git identity`. Show the missing-Git and missing-identity warnings once per VS Code session and include `My Code: Show Output` or `My Code: Retry` actions.

- [ ] **Step 6: Run checks and commit**

Run: `npm test -- --run test/manifest.test.ts`

Run: `npm run check`

Run: `npm run build`

Expected: pass and `dist/extension.js` exists.

Commit: `git commit -am "feat: activate repositories and automatic refresh"` after staging Task 5 files.

### Task 6: Explorer file decorations and MY CODE tree

**Files:**
- Create: `src/ui/fileDecorations.ts`
- Create: `src/ui/myCodeTree.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Test: `test/ui/myCodeTree.test.ts`

**Interfaces:**
- Consumes: `RepositoryRegistry`, `RepositorySnapshot`, and `RepositoryAnalyzer.ensureFile`.
- Produces: `MyCodeDecorationProvider` implementing `vscode.FileDecorationProvider`.
- Produces: `MyCodeTreeProvider` implementing `vscode.TreeDataProvider<MyCodeNode>`.
- Produces: commands `myCode.openFile`, `myCode.refresh`, and `myCode.showFileHistory`.

- [ ] **Step 1: Write tree projection tests over plain snapshot data**

Extract `projectTree(snapshot[])` as a pure function and assert a single repo has `CURRENT` then `PAST ACTIVITY`, current files sort by path, and multi-root workspaces add repository roots above those groups. Assert added and modified nodes retain `A` and `M` labels and past nodes retain `◷`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- --run test/ui/myCodeTree.test.ts`

Expected: failure because the projection/provider does not exist.

- [ ] **Step 3: Contribute the Explorer view and decorations**

Add `contributes.views.explorer` entry `{ "id": "myCode.explorer", "name": "MY CODE" }`. Register the tree and decoration providers. Return `new vscode.FileDecoration('A', 'Added by you', new vscode.ThemeColor('gitDecoration.addedResourceForeground'))` or the corresponding `M` color and set `propagate = true`. When a candidate is unresolved, call `ensureFile(path, 'explorer')` and fire a decoration event when it settles.

- [ ] **Step 4: Implement tree groups, file opening, and inline history children**

File nodes use workspace-relative labels, resource URIs, and `vscode.open`. Expanding a file returns matching `CommitSummary` children. Past deleted files have no open-file command but still expand. History child tooltips include full hash, author, date, and subject and dispatch `myCode.openCommitDiff` implemented in Task 8.

- [ ] **Step 5: Run checks and commit**

Run: `npm test -- --run test/ui/myCodeTree.test.ts`

Run: `npm run check`

Run: `npm run build`

Expected: pass.

Commit: `git commit -am "feat: show user files in Explorer"` after staging Task 6 files.

### Task 7: Editor ownership decorations and hover metadata

**Files:**
- Create: `src/ui/editorOwnership.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Test: `test/ui/editorOwnership.test.ts`

**Interfaces:**
- Consumes: `RepositoryRegistry`, `FileRecord.ranges`, and matching commit metadata from blame.
- Produces: `toDecorationOptions(record, document, commandFactory): vscode.DecorationOptions[]`.
- Produces: `EditorOwnershipController.refreshVisibleEditors()` and `refreshUri(uri)`.
- Produces: command `myCode.toggleLineBackground` backed by setting `myCode.editor.lineBackground`.

- [ ] **Step 1: Write pure mapping tests for ranges and hover text**

Assert `{ start: 1, endExclusive: 3 }` maps to a VS Code range from line 1 column 0 through line 3 column 0, clips to the document line count, includes short hash/date/subject in trusted Markdown, and encodes command arguments with `encodeURIComponent(JSON.stringify(args))` rather than string concatenation.

- [ ] **Step 2: Verify the editor mapping test fails**

Run: `npm test -- --run test/ui/editorOwnership.test.ts`

Expected: failure because the mapper/controller is absent.

- [ ] **Step 3: Implement gutter and overview ruler decoration types**

Use a theme-aware border in `gutterIconPath` only if a package-safe raster asset is added; otherwise use `isWholeLine`, `borderWidth: '0 0 0 2px'`, `borderStyle: 'solid'`, `borderColor: new ThemeColor('gitDecoration.modifiedResourceForeground')`, and `overviewRulerColor` with `OverviewRulerLane.Left`. Apply background color only when the setting is enabled.

- [ ] **Step 4: Implement visible-editor prioritization and hover commands**

On active/visible editor change and analyzer events, call `ensureFile(path, 'active-editor')`. Clear stale decorations immediately when a document leaves a repository or a refresh generation changes. Hover Markdown offers `$(history) File history` and `$(list-tree) Line history` command links and is marked trusted only for those exact command IDs.

- [ ] **Step 5: Run checks and commit**

Run: `npm test -- --run test/ui/editorOwnership.test.ts`

Run: `npm run check`

Run: `npm run build`

Expected: pass.

Commit: `git commit -am "feat: highlight user-owned editor lines"` after staging Task 7 files.

### Task 8: File history, line history, and read-only diffs

**Files:**
- Create: `src/ui/gitContentProvider.ts`
- Create: `src/ui/historyController.ts`
- Modify: `src/ui/myCodeTree.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Test: `test/ui/historyController.test.ts`

**Interfaces:**
- Consumes: `GitRepository.getFileHistory`, `getLineHistory`, `showFile`, and normalized identity matching.
- Produces: URI scheme `my-code-git` and `GitContentProvider.provideTextDocumentContent`.
- Produces: commands `myCode.showFileHistory`, `myCode.showLineHistory`, and `myCode.openCommitDiff`.

- [ ] **Step 1: Write tests for secure virtual URI encoding and identity-filtered QuickPick items**

```ts
const uri = revisionUri('C:\\repo', 'abc123^', 'src/a b.ts');
expect(parseRevisionUri(uri)).toEqual({ root: 'C:\\repo', revision: 'abc123^', path: 'src/a b.ts' });
expect(items.every(item => matchesIdentity(identity, item.commit.authorName, item.commit.authorEmail))).toBe(true);
```

Also assert malformed URIs and revisions outside `/^[0-9a-f]{7,64}(?:\^)?$/i` are rejected before Git execution.

- [ ] **Step 2: Run the focused history tests and verify failure**

Run: `npm test -- --run test/ui/historyController.test.ts`

Expected: failure because history modules are absent.

- [ ] **Step 3: Implement identity-filtered file and line history commands**

File history defaults to the active file when no URI is supplied. Line history defaults to the active selection's zero-based active line and passes one-based `line,line:path` to Git. Show newest-first QuickPick items with subject as label, relative date and short hash as description, and author/date/path as detail. Ignore non-matching commit records even if Git emits them for `-L` context.

- [ ] **Step 4: Implement virtual documents and first-parent commit diffs**

Encode JSON `{ root, revision, path }` with base64url in the URI path; never put a raw file path in the authority. `provideTextDocumentContent` loads bytes with `git show`, decodes UTF-8 with replacement, and returns an empty string for an absent parent/file. Open `vscode.diff(parentUri, commitUri, title, { preview: true })`.

- [ ] **Step 5: Run checks and commit**

Run: `npm test -- --run test/ui/historyController.test.ts`

Run: `npm run check`

Run: `npm run build`

Expected: pass.

Commit: `git commit -am "feat: connect code to personal Git history"` after staging Task 8 files.

### Task 9: Full verification, documentation, and VSIX delivery

**Files:**
- Create: `README.md`
- Create: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `.vscodeignore`
- Modify: any source or test file exposed by verification

**Interfaces:**
- Consumes: the complete extension.
- Produces: `my-code-0.1.0.vsix` and reproducible install/run instructions.

- [ ] **Step 1: Write the README from the actual product behavior**

Document zero-configuration activation, identity commands, `A/M/◷` meanings,
the `MY CODE` view, line hovers, file/line history, refresh command, desktop and
local-Git requirements, multi-root behavior, and troubleshooting. Include a
short manual acceptance recipe that creates commits from two authors and opens
the fixture in an Extension Development Host.

- [ ] **Step 2: Run the complete automated suite**

Run: `npm run check`

Run: `npm run test:run`

Run: `npm run build`

Expected: all exit 0, no skipped acceptance tests, and `dist/extension.js` exists.

- [ ] **Step 3: Inspect the production package contents**

Run: `npm run package`

Run: `npx @vscode/vsce ls`

Expected: `my-code-0.1.0.vsix` exists; it contains `dist/extension.js`,
`package.json`, `README.md`, `CHANGELOG.md`, and the license/notice files if
present; it excludes `src`, `test`, coverage, Git metadata, and local caches.

- [ ] **Step 4: Run an Extension Host smoke test when locally available**

Run: `code --version`.

If `code` exists, launch the project through the checked-in `.vscode/launch.json`
or use `@vscode/test-electron` with a temporary workspace fixture, assert that
activation completes and `myCode.refresh` is registered, then close the test
host. If `code` is absent, record that exact environmental limitation in
`README.md` under development verification while keeping build, tests, and VSIX
packaging mandatory.

- [ ] **Step 5: Review against every success criterion**

Confirm with test or manual evidence:

1. no setup UI appears when global identity exists;
2. only matching-author reachable files enter the index;
3. current committed and working lines are decorated in full-file context;
4. Explorer and `MY CODE` distinguish current and past paths;
5. file and line history exclude other authors;
6. saves, commits, checkout, and rebase fingerprints refresh state;
7. background scans are bounded and cached.

- [ ] **Step 6: Commit the release candidate**

Run: `git status --short` and inspect every path.

Commit: `git commit -am "docs: prepare My Code 0.1.0"` after staging the README,
changelog, manifest, VSIX ignore rules, and any verified corrections. Do not
commit the generated VSIX unless the repository policy explicitly changes.
