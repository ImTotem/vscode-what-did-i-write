<sub>Built entirely through vibe coding with Codex.</sub>

# What Did I Write?

Find the files, lines, and commits you authored.

[English](README.en.md) | [한국어](README.ko.md)

Supported UI languages: English and 한국어. The extension follows VS Code's display language automatically.

What Did I Write? is a desktop VS Code extension that finds the code you wrote in the currently checked-out Git repository. It starts automatically after VS Code finishes loading. There is no sign-in, base-commit picker, cloud service, or GitHub dependency.

All analysis uses your local Git installation. The extension reads only global `user.name` and `user.email` and compares them with commit authors reachable from the current `HEAD`. A matching name or email is enough. Staged, unstaged, and untracked files are treated as your current work.

## Requirements and installation

- Desktop VS Code 1.96 or newer. Web extension hosts are not supported.
- A local `git` executable on `PATH`.
- At least one global Git identity field: `user.name` or `user.email`.

Build and install the local package:

```powershell
npm install
npm run package
code --install-extension .\what-did-i-write-0.2.1.vsix
```

Open a Git repository after installation. Non-Git folders are ignored. If Git or the global identity is missing, the extension shows an actionable warning and writes details to the **What Did I Write?** output channel.

## What you see

In the normal Explorer, only files containing your current code are decorated, and the indication propagates to parent folders:

- `A` — a current file introduced by you, or an untracked file.
- `M` — a file containing a line attributed to you, or a staged/unstaged change.
- `◷` — a path you touched historically whose work no longer survives. It appears in **PAST ACTIVITY**, not as a current Explorer badge.

The **MY CODE** icon is an independent Activity Bar destination next to Explorer and Source Control. It contains three sibling views:

- **MY CHANGES** — an Explorer-like folder hierarchy containing your current files; multi-selection includes unique descendant files.
- **PAST ACTIVITY** — a collapsed-by-default, newest-first list of paths you changed in the past.
- **FILE HISTORY** — the selected files' combined newest-first commits and authored-line statistics.

Open a candidate text file to see VS Code's native Quick Diff gutter marker for your authored lines. The full source stays visible and no border is drawn over the code.
What Did I Write? supplies a virtual original with your authored lines removed; VS Code renders the marker according to `scm.diffDecorations`.
The marker expands on hover, and clicking it opens VS Code's native inline diff. The built-in Git quick-diff source remains available.
Use **FILE HISTORY** or the Line History and File History commands for commit history.
Binary files can be listed but are never line-decorated.

The history timeline keeps current working changes at the top, then lists commits from newest to oldest. Commits render before background statistics, which are indexed once per HEAD and applied together with themed colors and thousands separators. Clicking an entry keeps the source file pinned and opens or updates one reusable preview diff beside it.

## Where features live

| Location | What is there |
| --- | --- |
| Activity Bar → **MY CODE** | Only your current and past authored files. |
| **MY CHANGES** title bar | Refresh, Collapse All, and Hide / Show My Code Decorations. |
| **MY CHANGES** context menu | Explorer-style open, reveal, path copy, create, cut/copy/paste, rename, and delete actions. |
| Editor native Quick Diff gutter / overview ruler | VS Code-native markers for lines attributed to you. |
| Editor gutter hover / click | The marker expands on hover; click it for the native inline diff. Use **FILE HISTORY** for commit history. |
| **FILE HISTORY** | Combined selection history with current-line, per-commit, and BASE comparison statistics. |
| Command Palette | Every What Did I Write? command, including Retry and Show Output. |

## Commands and settings

- `What Did I Write?: Refresh` — refresh every discovered repository and all views.
- `What Did I Write?: Collapse All` — collapse every open folder in the list.
- `What Did I Write?: Hide My Code Decorations` / `Show My Code Decorations` — persist the workspace visual mode.
- `What Did I Write?: Retry` — retry identity discovery after changing global Git config.
- `What Did I Write?: Show Output` — open diagnostic details.
- `What Did I Write?: Show File History` — show matching history for the active or selected file.
- `What Did I Write?: Show Line History` — show matching history for the active line.
- `What Did I Write?: Toggle Line Background` — toggle the optional owned-line background.

Current file and folder rows support Explorer-style right-click actions. Internal drag/drop moves within a repository and copies across repositories; external file URI drops copy files only after containment and name-conflict checks. Past activity is intentionally read-only, apart from history and path-copy actions.

`myCode.visuals.enabled` defaults to `true`. Turn it off to hide ownership colors and native Quick Diff markers in Explorer and the editor while keeping analysis and all views active. `myCode.editor.lineBackground` defaults to `false`; enable it for a subtle whole-line background in addition to native Quick Diff markers.

## Multi-root workspaces and refresh

Each workspace folder is resolved independently. Folders mapped to the same Git worktree share one analysis model; non-Git folders have no What Did I Write? state.

The extension reacts to saves, creates, deletes, renames, workspace-folder changes, visible-editor changes, and repository fingerprint changes while VS Code is focused. Refresh, checkout, commit, and rebase rebuild the relevant index. After changing global `user.name` or `user.email`, run **Retry** or **Refresh** to reload the identity.

Matching reachable paths are scanned first. Active editors and Explorer requests take priority over background work. Git subprocesses are limited to four per repository, and persistent caches contain metadata and paths only—never source contents.

## Privacy and local-only behavior

What Did I Write? does not call GitHub or any remote API, require an account, or upload repository data. Git runs locally with argument arrays; paths and identities are not interpolated into shell commands.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `What Did I Write?: Git identity` | Set at least one of `git config --global user.name` or `git config --global user.email`, then run **Retry**. |
| Git warning or no results | Confirm `git --version` works in VS Code's environment, then open **Show Output**. |
| A file is missing | Confirm it is reachable from the checked-out `HEAD` and authored by the configured identity; refresh after changing branches or history. |
| No line markers | Open a current candidate text file. Binary files intentionally have no markers. |
| Fewer commits than `git log` | History intentionally includes only matching authors reachable from the current `HEAD`. |
| UI language is unexpected | Change VS Code's display language and reload the window. English and Korean are included. |

## Development and verification

```powershell
npm install
npm run check
npm run test:run
npm run build
npx @vscode/vsce ls
npm run package
npm run test:extension-host
```

For manual acceptance, open this extension project in VS Code and press `F5` to launch an **Extension Development Host**. Open a Git repository containing commits by at least two authors, ensure your global Git identity matches one author, and verify:

1. **MY CHANGES** contains only your current files in a collapsible folder tree.
2. **PAST ACTIVITY** is newest-first and remains read-only.
3. Native Quick Diff gutter and overview-ruler markers appear without covering source code.
4. A gutter marker expands on hover and opens VS Code's native inline diff when clicked.
5. Clicking a timeline commit keeps the source open and displays that commit's diff beside it.
6. Hide My Code Decorations removes Explorer and editor ownership visuals without disabling the views.
7. Switching VS Code between English and Korean changes the complete extension UI after reload.
