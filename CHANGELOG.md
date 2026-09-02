# Changelog

All notable changes to this project are documented in this file.

## 0.2.2 - 2026-09-02

- Moves focus to a nearby retained selection after Ctrl-deselecting a MY CHANGES row.
- Opens files in preview on one click and pins the tab on the second same-file click.

## 0.2.1 - 2026-09-02

- Renders selected commit history immediately from the analyzed file index.
- Adds HEAD-scoped commit/path statistics indexes with bounded reuse.
- Applies all commit statistics together after background calculation.
- Colors file, line, added, modified, and deleted counts and adds thousands separators.

## 0.2.0 - 2026-09-02

- Combines MY CHANGES file and folder selections into one newest-first FILE HISTORY timeline.
- Shows current authored lines, per-commit line changes, and fixed-height BASE comparison totals.
- Clears FILE HISTORY when the MY CHANGES selection is cleared.

## 0.1.1 - 2026-08-31

- Replaced the unreliable Expand All action with a persistent Collapse All action.
- Added direct right-click comparison-base selection and second-click clearing in File History.

## 0.1.0 - 2026-08-26

Initial local-only MVP release.

- Detects the current global Git identity and indexes reachable authored paths.
- Shows current and past personal code in Explorer, the `MY CODE` view, and
  editor line decorations.
- Provides identity-filtered file and line history with read-only Git diffs.
- Refreshes local analysis for editor and repository changes with bounded Git
  concurrency and metadata-only caching.
