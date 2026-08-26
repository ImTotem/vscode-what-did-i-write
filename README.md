# What Did I Write?

Find the files, lines, and commits you authored.

What Did I Write? is a desktop VS Code extension for finding the code you wrote in the
currently checked-out Git repository. It runs automatically when VS Code has
finished starting: there is no account sign-in, base-commit picker, setup
screen, cloud service, or GitHub dependency.

All analysis uses your local Git installation. What Did I Write? reads only global
`user.name` and `user.email`, then compares them with authors in commits
reachable from the current `HEAD`. A matching name **or** email is enough.
Staged, unstaged, and untracked files are treated as your current work.

## Requirements and installation

- Desktop VS Code 1.96 or newer. Web extension hosts are not supported.
- A local `git` executable available on `PATH`.
- At least one global Git identity field (`user.name` or `user.email`).

Build a local installable package with `npm run package`, then install it:

```powershell
code --install-extension .\what-did-i-write-0.1.0.vsix
```

Open a Git repository after installation. Folders outside Git repositories are
left alone. If VS Code cannot find Git, or no global identity is configured,
What Did I Write? shows one actionable warning and keeps the details in the **What Did I Write?** output channel.

## What you see

In the normal Explorer, What Did I Write? decorates only files containing your current
code and propagates the indication to their parent folders:

- `A` — a current file introduced by you, or a current untracked file.
- `M` — a file with a line attributed to you, or a staged/unstaged change.
- `◷` — a path you touched historically whose work no longer survives. This
  appears under **PAST ACTIVITY**, not as a current Explorer badge.

The **MY CODE** icon is an independent Activity Bar destination, next to
Explorer and Source Control. Its sidebar has three sibling views: **MY CHANGES**
for current files, collapsed-by-default **PAST ACTIVITY** for a flat newest-first
history list, and **FILE HISTORY** for the selected file or line. Expand folders
in **MY CHANGES** and select a file to open it; selecting a past row focuses its
history without making the deleted path mutable.

The **MY CHANGES** list uses a collapsible Explorer-like folder hierarchy.
The **FILE HISTORY** view places saved working changes first and the newest commit at the top.
Its vertical rail points toward older matching commits, so the time direction is visible
without reading every timestamp. Clicking a commit keeps the source pinned and updates
one reusable preview diff beside it.

When you open a candidate text file, What Did I Write? keeps the complete current file
visible and marks your lines in the glyph gutter and overview ruler. It no
longer draws a border inside the code content. The stable VS Code extension API
does not expose direct minimap decorations, so the overview ruler beside the
minimap is used instead. Hover a gutter marker to see a compact ownership card,
then choose line or file history.
Binary files may be listed, but are never line-decorated.

## Where features live

| Location | What is there |
| --- | --- |
| Activity Bar → **MY CODE** | Only your current and past changed files. |
| **MY CHANGES** title bar | Refresh, Expand All / Collapse All, and Hide / Show My Code Decorations. |
| Editor glyph gutter / overview ruler | Committed and working ownership markers outside the code content. |
| Editor gutter hover | Current ownership plus Line History and File History actions. |
| **FILE HISTORY** | Newest-first commit rail; click an entry to update the reusable preview diff beside the source. |
| Command Palette | Every What Did I Write? command, including Retry and Show Output. |

## Commands and setting

The same actions are also available from the Command Palette:

- `What Did I Write?: Refresh` — refresh every discovered repository and all three views.
- `What Did I Write?: Expand All` / `Collapse All` — expand every current folder or collapse the list.
- `What Did I Write?: Hide My Code Decorations` / `Show My Code Decorations` — persist the workspace visual mode.
- `What Did I Write?: Retry` — retry identity discovery after changing global Git config.
- `What Did I Write?: Show Output` — open diagnostic details.
- `What Did I Write?: Show File History` — show matching history for the active or selected file.
- `What Did I Write?: Show Line History` — show matching history for the active line.
- `What Did I Write?: Toggle Line Background` — toggle the optional owned-line background.

File and folder context menus also provide Explorer-style open, reveal, path-copy,
new, cut/copy/paste, rename, and delete actions where the row is mutable. Internal
drag/drop moves within a repository and copies across repositories; external file
URI drops copy in only after containment and name-conflict checks.

The setting `myCode.visuals.enabled` defaults to `true`; turn it off to hide
ownership colors and markers while keeping analysis and views active. The
setting `myCode.editor.lineBackground` defaults to `false`. Enable it if
you want a subtle whole-line background in addition to the gutter and ruler.

## Multi-root workspaces and refresh

Every workspace folder is resolved independently. Folders that map to the same
Git worktree share one analysis model; a non-Git folder has no What Did I Write? state.

What Did I Write? reacts to saves, creates, deletes, renames, workspace-folder changes,
visible-editor changes, and focused-window repository fingerprint checks. An
explicit refresh, checkout, commit, or rebase rebuilds the relevant index. A
global identity change is not detected by repository fingerprint polling; after
changing `user.name` or `user.email`, run `What Did I Write?: Retry` or `What Did I Write?: Refresh`
to re-read the identity and rebuild the index. It scans matching reachable
paths first, processes active editors and Explorer requests ahead of background
work, bounds Git subprocesses to four per repository, and caches only index
metadata—never source contents.

## Privacy and local-only behavior

What Did I Write? does not call GitHub or any remote API, does not require an account,
and does not upload repository data. Git is run locally with argument arrays;
paths and identities are not interpolated into shell commands. Its persistent
cache contains reachable commit metadata and paths only, not file contents.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `What Did I Write?: Git identity` is shown | Run `git config --global user.name` and `git config --global user.email`; set at least one value, then run `What Did I Write?: Retry`. |
| Git warning or no results | Confirm `git --version` works in VS Code's environment, then open `What Did I Write?: Show Output`. |
| A file is missing | Confirm it is reachable from the checked-out `HEAD` and was authored by the configured identity; use `What Did I Write?: Refresh` after changing branches or history. |
| No line markers | Open a text file that is current and a candidate for your history; binary files intentionally have no markers. |
| History has fewer commits than `git log` | What Did I Write? intentionally filters to matching authors and the current `HEAD` ancestry. |

## Development and manual acceptance

Install dependencies, then run the reproducible checks:

```powershell
npm run check
npm run test:run
npm run build
npm run package
npx @vscode/vsce ls
```

For a short manual acceptance check, create a two-author fixture and open it
in an Extension Development Host. First make sure your *global* Git identity
matches `Me <me@example.test>` (What Did I Write? deliberately reads global identity):

```powershell
$fixture = Join-Path $env:TEMP 'my-code-manual-fixture'
Remove-Item -Recurse -Force $fixture -ErrorAction SilentlyContinue
New-Item -ItemType Directory $fixture | Out-Null
Set-Location $fixture
git init
git config user.name 'Alice'
git config user.email 'alice@example.test'
Set-Content upstream.ts 'const upstream = true;'
git add upstream.ts; git commit -m 'upstream file'
git config user.name 'Me'
git config user.email 'me@example.test'
Set-Content mine.ts 'const mine = true;'
git add mine.ts; git commit -m 'my file'
git config user.name 'Alice'
git config user.email 'alice@example.test'
Add-Content upstream.ts "`nconst later = true;"
git add upstream.ts; git commit -m 'other change'
```

Open this extension project in VS Code, press `F5` to start an **Extension
Development Host**, and then open `$fixture` in that host. `mine.ts` should be
shown as `A`; `upstream.ts` should not be shown as yours. Add an uncommitted
line to `mine.ts`, save it, and verify its line decoration and hover appear.

When the `code` executable is installed, live Extension Host activation and
registration of `myCode.refresh` are required release gates. If VS Code cannot
start its Extension Host because of an environment problem (such as an updater
mutex), that gate remains incomplete; rerun it after the problem clears or use
a separate test runtime. Type checking, automated tests, bundling, and VSIX
inspection are separate mandatory checks, not substitutes for this live-host
assertion.
