# Changelog

All notable changes to this project are documented in this file.

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
