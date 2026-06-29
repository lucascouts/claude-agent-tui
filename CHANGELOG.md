# Changelog

All notable changes to claude-agent-tui will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project is a fork of [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) v0.39.0 (see [`.fork-provenance.json`](.fork-provenance.json)).

## [0.6.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.5.2...v0.6.0) (2026-06-29)


### Features

* **panel:** hybrid agent discovery — probe claude for canonical list + glob fallback ([29948ce](https://github.com/lucascouts/claude-agent-tui/commit/29948ce2fabad101eec0ea1bc84b8fe979be52a2))
* **panel:** live /effort + pre-interaction fresh re-spawn for agent/mode + optimistic mode feedback ([fa0b6b5](https://github.com/lucascouts/claude-agent-tui/commit/fa0b6b56a029c23b5865d3162955b586af07f042))
* **panel:** surface auto permission mode + realign model catalog to the original ([93e0d11](https://github.com/lucascouts/claude-agent-tui/commit/93e0d11beececd1a3e95a3f93db78f82f3b0a882))
* **panel:** ultracode effort-selector entry — sentinel + Option A apply (story 060) ([1c36be7](https://github.com/lucascouts/claude-agent-tui/commit/1c36be7835ccad82bc604007ec412b5d92686caa))
* **panel:** v0.52 parity — effort selector, agent picker, render fixes, title push ([b4e99d6](https://github.com/lucascouts/claude-agent-tui/commit/b4e99d6bea7486a52ff59cee23a19e9358a558b8))


### Bug Fixes

* **059:** claude-path tests→dist + SettingsManager fs.watch unref; devDeps v0.52 bump ([da5fd09](https://github.com/lucascouts/claude-agent-tui/commit/da5fd09df8ca6f4f446b3a772895e21860099da3))
* **effort:** map ultracode sentinel to xhigh at the mode/agent re-spawn seam (R1.2) ([39c215d](https://github.com/lucascouts/claude-agent-tui/commit/39c215d332ec0f0acbfb3eb8648e24080ac18ed4))
* **image:** satisfy eqeqeq in vision smoke + bind temp-image sink before promptToClaude ([266a777](https://github.com/lucascouts/claude-agent-tui/commit/266a777a7447a03ec4495b69b0275fe91e60905c))

## [0.5.2](https://github.com/lucascouts/claude-agent-tui/compare/v0.5.1...v0.5.2) (2026-06-27)


### Bug Fixes

* **gate:** live correlation + subagent attribution (story 055 sync) ([aa97908](https://github.com/lucascouts/claude-agent-tui/commit/aa979084e213be38f059fc1da74afafc001c1b53))

## [0.5.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.5.0...v0.5.1) (2026-06-25)


### Bug Fixes

* **ci:** Cosign sign-blob --bundle (v4 deprecated --output-signature/-certificate) ([5c57a3f](https://github.com/lucascouts/claude-agent-tui/commit/5c57a3f573a16efab1b9b9ae824f9298e507ed06))

## [0.5.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.4.0...v0.5.0) (2026-06-25)


### Features

* **049:** claude binary drift resilience — mirror sync ([c91b833](https://github.com/lucascouts/claude-agent-tui/commit/c91b8333d1cf3ed466a816d81af5befe4dfc5ff8))
* **054:** subagent permission relay (mirror) + PERMISSIONS.md ([9c8b308](https://github.com/lucascouts/claude-agent-tui/commit/9c8b30855974e200e3575d8ac0ebd8c58d993eef))

## [0.4.0](https://github.com/lucascouts/claude-agent-tui/compare/v0.3.1...v0.4.0) (2026-06-23)


### Features

* **deps:** update dependency chain + clear advisories (mirror fork story 047) ([99be617](https://github.com/lucascouts/claude-agent-tui/commit/99be61736fd49a920fd1f6bf98633ec5e214e3a0))


### Bug Fixes

* linear-time local-command marker stripping (CodeQL js/polynomial-redos) (mirror fork story 052) ([b75e9c9](https://github.com/lucascouts/claude-agent-tui/commit/b75e9c98bc8ec320e27340ade397e6c9e1936277))

## [0.3.1](https://github.com/lucascouts/claude-agent-tui/compare/v0.3.0...v0.3.1) (2026-06-19)


### Documentation

* note June 15 pause of the SDK billing split (README + npm description) ([a427339](https://github.com/lucascouts/claude-agent-tui/commit/a4273392379962431599140df3b47ec1127a8677))

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
