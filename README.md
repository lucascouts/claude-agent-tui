# claude-agent-tui

[![npm](https://img.shields.io/npm/v/@lucascouts/claude-agent-tui)](https://www.npmjs.com/package/@lucascouts/claude-agent-tui)

An [ACP](https://agentclientprotocol.com)-compatible agent that drives the **Claude Code subscription TUI** over a PTY, so your Claude Code threads render natively in [Zed](https://zed.dev) and other ACP clients.

> **Fork** of [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) v0.39.0. Where the upstream adapter calls the Claude Agent **SDK**, this fork spawns the `claude` **subscription CLI** in a pseudo-terminal and translates its JSONL transcript into ACP `session/update` notifications. See [`.fork-provenance.json`](.fork-provenance.json) for the exact fork point.

## Why this exists

On **June 15, 2026**, [Anthropic split Claude subscription billing](https://zed.dev/blog/anthropic-subscription-changes) into two pools: Anthropic's **first-party tools** (chat and the official **Claude Code CLI**) keep using your **Pro/Max subscription**, while **third-party agents and SDK usage** are billed separately at **API rates** — roughly **15–30× more expensive** (separate monthly credits: $20 Pro / $100 Max 5x / $200 Max 20x).

In practice, Zed's built-in Claude integration now draws from those expensive third-party credits instead of your subscription. The official `claude` CLI/TUI, however, **still runs on your subscription**.

This project bridges the two: it drives the **official Claude Code TUI** over a PTY and exposes it through the **ACP** protocol, so Zed renders it as a native agent panel — giving you the full Claude Code experience inside Zed **on your existing subscription**, not API credits.

### Update notice

"Update June 15: We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription's usage limits. The previously announced monthly credit, which would have been available to eligible claimants in connection with these changes, isn't available. We’re working to update the plan to better support how users build with Claude subscriptions. When we have an update, we'll share it before anything takes effect."

[`https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

> Not affiliated with or endorsed by Anthropic or Zed Industries. Use of the `claude` CLI remains subject to Anthropic's terms.

## Requirements

- The **`claude` CLI** (Claude Code subscription) available on your `PATH`.
- **Node.js ≥ 23** — the runtime and test suite use native TypeScript type-stripping.

## Register in Zed

Build the agent, then point Zed's `agent_servers` at the built entrypoint:

```jsonc
// ~/.config/zed/settings.json
{
  "agent_servers": {
    "Claude Agent TUI": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/claude-agent-tui/dist/index.js"],
      "env": {},
    },
  },
}
```

Open the Agent Panel in Zed and select **Claude Agent TUI**.

## Build & test

```sh
npm install
npm run build
npm test
```

## Capabilities

- Renders Claude Code threads: text, thinking, tool calls, structured diffs, TODO plans, and nested sub-agents
- Token-usage updates
- Prompt input, cancellation, and session load/replay

## Supply-chain notes

[Socket](https://socket.dev/npm/package/@lucascouts/claude-agent-tui) flags some
dependency alerts (`Native code`, `Install scripts`, `Shell access`, plus
heuristic flags on the Anthropic SDK tree). **None are CVEs or malware** — they
are expected capability flags:

- `node-pty` (the same PTY that powers VS Code) needs `Native code` /
  `Install scripts` / `Shell access` — driving the `claude` TUI in a real PTY is
  the whole point of this bridge.
- The remaining flags come from the minified bundles inside
  `@anthropic-ai/claude-agent-sdk`, of which this fork uses only two pure,
  billing-free functions (`getSessionMessages`, `resolveSettings`).

All direct dependencies are first-party publishers (Microsoft, Anthropic, Zed).

## License

[Apache-2.0](LICENSE). This is a derivative work; original copyright belongs to Zed Industries and the Agent Client Protocol authors.
