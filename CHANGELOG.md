# Changelog

All notable changes to claude-agent-tui will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project is a fork of [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) v0.39.0 (see [`.fork-provenance.json`](.fork-provenance.json)).

## [0.2.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.1.1...v0.2.0) (2026-06-12)


### Features

* migrate @agentclientprotocol/sdk to 0.25.0 (SessionModel → configOption "model") ([8d7b87d](https://github.com/lucascouts/claude-agent-tui/commit/8d7b87d23d7cf0288dd9e0f5548069d809b7cc09))

## [0.1.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.1.0...v0.1.1) (2026-06-12)


### Bug Fixes

* **lint:** clear 10 eslint errors in src (no-undef, cause, default-case, const) ([617a2f5](https://github.com/lucascouts/claude-agent-tui/commit/617a2f5cfef722ba9e056b640f307bb00227883e))

## [Unreleased]

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

[Unreleased]: https://github.com/lucascouts/claude-agent-tui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lucascouts/claude-agent-tui/releases/tag/v0.1.0
