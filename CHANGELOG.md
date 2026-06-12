# Changelog

## 0.1.0

Initial public release.

Forked from [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) **v0.39.0** (see [`.fork-provenance.json`](.fork-provenance.json) for the exact commit).

### Changed from upstream

- The engine drives the **Claude Code subscription TUI over a PTY** instead of calling the Claude Agent SDK, translating the JSONL transcript into ACP `session/update` notifications.
- Reports `agentInfo.title` as **"Claude Agent TUI"**.
- Dropped the upstream vitest suite; the regression suite runs under `node --test` (`npm test`).
