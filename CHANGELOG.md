# Changelog

All notable changes to claude-agent-tui will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project is a fork of [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) v0.39.0 (see [`.fork-provenance.json`](.fork-provenance.json)).

## [0.3.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.2.2...v0.3.0) (2026-06-19)


### Features

* live Agent Panel selectors (model/effort/permission-mode) + model-switch hang fix ([b1c56d4](https://github.com/lucascouts/claude-agent-tui/commit/b1c56d4804ece8574feee4fca1e6c20784b7fe48))


### Bug Fixes

* **046:** defer discovery + guard for in-place re-spawn (live boot-bypass stall) ([cd6ac2e](https://github.com/lucascouts/claude-agent-tui/commit/cd6ac2e4768ae2b878b824e67e4cf5fd184dcca9))
* **046:** permission mode drives the TUI + gate honors mode (Bug A) ([4826257](https://github.com/lucascouts/claude-agent-tui/commit/482625775ec35e239a6d40c64925e57f3d5a0139))
* **deps:** treat BetaFallbackBlock as no-op (@anthropic-ai/sdk 0.104) ([bdfff4b](https://github.com/lucascouts/claude-agent-tui/commit/bdfff4b613c157bcaf191a2cd808eb23bf23af53))

## [0.2.2](https://github.com/lucascouts/claude-agent-tui/compare/v0.2.1...v0.2.2) (2026-06-13)


### Miscellaneous Chores

* release 0.2.2 ([d93c027](https://github.com/lucascouts/claude-agent-tui/commit/d93c027182354acfaa770fca82b5cbf566b2f282))

## [0.2.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.2.0...v0.2.1) (2026-06-12)


### Miscellaneous Chores

* release 0.2.1 ([1783f85](https://github.com/lucascouts/claude-agent-tui/commit/1783f85f4a1512b4b9480e1689f65fe024d10126))

## [0.2.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.1.1...v0.2.0) (2026-06-12)


### Features

* migrate @agentclientprotocol/sdk to 0.25.0 (SessionModel → configOption "model") ([8d7b87d](https://github.com/lucascouts/claude-agent-tui/commit/8d7b87d23d7cf0288dd9e0f5548069d809b7cc09))
  * `0.25.0` removed the `SessionModel` protocol surface. Model selection now flows through the generic `configOptions` mechanism (`category: "model"`), built from `modelInfos` — the advertised selector content is unchanged.
  * Removed the dead legacy surface: the `SessionModelState` / `SetSessionModel*` types, the `unstable_setSessionModel` method, and the `models` field on `NewSessionResponse`. Internal model-matching logic (`resolveModelPreference`, `inferContextWindowFromModel`, …) is preserved unchanged.
  * Updated the `session-update-union` pin to `0.25.0`; the `SessionUpdate` union additively gained `plan_update` and `plan_removed`.
  * Dropped the `@agentclientprotocol/sdk` hold from Dependabot now that the migration has landed.

## [0.1.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.1.0...v0.1.1) (2026-06-12)


### Bug Fixes

* **lint:** clear 10 eslint errors in src (no-undef, cause, default-case, const) ([617a2f5](https://github.com/lucascouts/claude-agent-tui/commit/617a2f5cfef722ba9e056b640f307bb00227883e))

## [0.1.0] - 2026-06-12

### Added

- ACP agent that drives the **Claude Code subscription TUI over a PTY**, rendering Claude Code threads in Zed and other ACP-compatible clients.
- Rendering of text, thinking, tool calls, structured diffs, TODO plans, and nested sub-agents.
- Token-usage updates, prompt input, cancellation, and session load/replay.
- `NOTICE` file with upstream attribution (Apache-2.0 derivative work).

### Changed

- **Engine rewrite**: spawns the `claude` subscription CLI in a pseudo-terminal and translates its JSONL transcript into ACP `session/update` notifications, instead of calling the Claude Agent SDK.
- `agentInfo.title` is reported as **"Claude Agent TUI"**.

### Removed

- Upstream vitest suite; the regression suite now runs under `node --test` (`npm test`).

[0.1.0]: https://github.com/lucascouts/claude-agent-tui/releases/tag/v0.1.0
