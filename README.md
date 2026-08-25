# My Code

My Code is a desktop VS Code extension for finding the code you wrote in the
currently checked-out Git repository. It runs automatically when VS Code has
finished starting: there is no account sign-in, base-commit picker, setup
screen, cloud service, or GitHub dependency.

All analysis uses your local Git installation. My Code reads only global
`user.name` and `user.email`, then compares them with authors in commits
reachable from the current `HEAD`. A matching name **or** email is enough.
Staged, unstaged, and untracked files are treated as your current work.

## Requirements and installation

- Desktop VS Code 1.96 or newer. Web extension hosts are not supported.
- A local `git` executable available on `PATH`.
- At least one global Git identity field (`user.name` or `user.email`).

Build a local installable package with `npm run package`, then install it:

```powershell
code --install-extension .\my-code-0.1.0.vsix
```

Open a Git repository after installation. Folders outside Git repositories are
left alone. If VS Code cannot find Git, or no global identity is configured,
My Code shows one actionable warning and keeps the details in the **My Code**
output channel.

## What you see

In the normal Explorer, My Code decorates only files containing your current
code and propagates the indication to their parent folders:

- `A` — a current file introduced by you, or a current untracked file.
- `M` — a file with a line attributed to you, or a staged/unstaged change.
- `◷` — a path you touched historically whose work no longer survives. This
  appears under **PAST ACTIVITY**, not as a current Explorer badge.

The **MY CODE** Explorer view groups each repository into **CURRENT** and
**PAST ACTIVITY**. Current files open normally; both current and past files
expand to your relevant commits. Selecting a commit opens a read-only
first-parent diff.

When you open a candidate text file, My Code keeps the complete current file
visible and marks your lines in the gutter and overview ruler. Hover a marked
line for its author, date, short commit hash, subject, and links to file or
line history. Binary files may be listed, but are never line-decorated.

## Commands and setting

Use the Command Palette for:

- `My Code: Refresh` — refresh every discovered repository.
- `My Code: Retry` — retry identity discovery after changing global Git config.
- `My Code: Show Output` — open diagnostic details.
- `My Code: Show File History` — show matching history for the active or
  selected file.
- `My Code: Show Line History` — show matching history for the active line.
- `My Code: Toggle Line Background` — toggle the optional owned-line background.

The setting `myCode.editor.lineBackground` defaults to `false`. Enable it if
you want a subtle whole-line background in addition to the gutter and ruler.

## Multi-root workspaces and refresh

Every workspace folder is resolved independently. Folders that map to the same
Git worktree share one analysis model; a non-Git folder has no My Code state.

My Code reacts to saves, creates, deletes, renames, workspace-folder changes,
visible-editor changes, and focused-window repository fingerprint checks. An
explicit refresh, checkout, commit, rebase, or global identity change rebuilds
the relevant index. It scans matching reachable paths first, processes active
editors and Explorer requests ahead of background work, bounds Git subprocesses
to four per repository, and caches only index metadata—never source contents.

## Privacy and local-only behavior

My Code does not call GitHub or any remote API, does not require an account,
and does not upload repository data. Git is run locally with argument arrays;
paths and identities are not interpolated into shell commands. Its persistent
cache contains reachable commit metadata and paths only, not file contents.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `My Code: Git identity` is shown | Run `git config --global user.name` and `git config --global user.email`; set at least one value, then run `My Code: Retry`. |
| Git warning or no results | Confirm `git --version` works in VS Code's environment, then open `My Code: Show Output`. |
| A file is missing | Confirm it is reachable from the checked-out `HEAD` and was authored by the configured identity; use `My Code: Refresh` after changing branches or history. |
| No line markers | Open a text file that is current and a candidate for your history; binary files intentionally have no markers. |
| History has fewer commits than `git log` | My Code intentionally filters to matching authors and the current `HEAD` ancestry. |

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
matches `Me <me@example.test>` (My Code deliberately reads global identity):

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

Development verification is run against the local VS Code executable when it
is available. The package itself remains useful without that optional local
smoke environment because type checking, automated tests, bundling, and VSIX
inspection are separate mandatory checks.
