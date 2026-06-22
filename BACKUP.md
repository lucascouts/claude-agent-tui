# Backup Topology — Published Mirror

This repository (`claude-agent-tui`) is the **published mirror**: an isolated,
publishable copy of the parent monorepo's `fork/` directory. It is its own git
repo with its own remote, and is `.gitignore`d by the parent.

**It is NOT the source of truth.** The source of truth is the parent monorepo
`agent-painel-ui`, where `fork/` lives as a **subdirectory** (not its own repo:
`git -C fork rev-parse --show-toplevel` resolves to the parent).

## Remotes

| Tree | Remote | Visibility | Purpose |
|---|---|---|---|
| Published mirror (this repo) | `git@github.com:lucascouts/claude-agent-tui.git` | public | npm package `@lucascouts/claude-agent-tui`. |
| Parent monorepo (source of truth) | `git@github.com:lucascouts/agent-painel-ui-backup.git` | **PRIVATE** | Off-disk backup of the whole plan + `fork/` + docs. |

## Posture (deliberate)

- The parent backup repo is **PRIVATE** — never make it public.
- **Private backup ≠ public publish.**
- Publishing here goes through a **release-please PR merge**. A plain push only
  opens/updates a release PR — **do not merge it** (publish deferred, 047 R5.2).
  Docs-only commits (like this file) do not trigger a release.
