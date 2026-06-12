// Story 027 / Task 4.1 — E2E (live tier): a TUI-driven turn streams into the client as
// session/update, read-only (R2.1, R5.1, R5.2).
//
// INTEGRATION test — gated behind RUN_INTEGRATION_TESTS=true (spawns the REAL `claude` TUI,
// completes one tiny assistant turn, uses the subscription). It drives the FULL read path
// in-product: the real ClaudeAcpAgent (default engine + default startEngine) createSession
// spawns claude under a PTY; a prompt is typed INTO the mirrored TUI (PTY write — NOT an ACP
// session/prompt); the deferred glob discovery (R5.1/R5.2: basename==sessionId, cwd from
// .cwd) arms the watcher on the first interaction; the tail-driven pump live-re-reads via
// getSessionMessages and emits session/update. Asserts at least one agent-message update is
// produced AND that NO session/prompt was issued from the ACP side (read-only).
//
// The "render visible in Zed's Agent Panel" half is the manual live-acceptance step (the
// zed binary is not on PATH here); this harness covers the agent→client update stream.
//
// node:test runner (use --test-force-exit: the external claude TUI keeps a PTY handle open, so the
// node event loop does not drain on its own after the test passes):
//   RUN_INTEGRATION_TESTS=true npm run build && \
//   RUN_INTEGRATION_TESTS=true node --experimental-strip-types --test --test-force-exit test/e2e-tui-turn-renders.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

const RUN = process.env.RUN_INTEGRATION_TESTS === "true";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const TUI_BOOT_MS = 4000; // let the TUI initialize before typing (it writes no transcript at boot)
const SUBMIT_DELAY_MS = 60; // write text, then a delayed \r submits it (§5 Input)
const TURN_TIMEOUT_MS = 90_000; // bounded wait for the assistant turn to surface an agent message

test(
  "live: a TUI-typed prompt streams the turn into the client as session/update, read-only (R2.1)",
  {
    skip: RUN ? false : "integration: set RUN_INTEGRATION_TESTS=true to run (spawns the real claude TUI, uses subscription)",
    timeout: TURN_TIMEOUT_MS + 30_000,
  },
  async (t) => {
    const captured: any[] = [];
    let resolveMsg!: () => void;
    const sawAgentMessage = new Promise<void>((res) => {
      resolveMsg = res;
    });
    const client = {
      sessionUpdate: async (n: any) => {
        captured.push(n);
        if (n.update?.sessionUpdate === "agent_message_chunk") resolveMsg();
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as never;

    // The REAL agent: default engine + default startEngine → real `claude`, real discovery, real pump.
    const agent: any = new ClaudeAcpAgent(client, console);
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await agent.createSession({ cwd: process.cwd(), mcpServers: [] }));
      assert.ok(sessionId, "createSession resolved with a sessionId (deferred discovery, story 028)");

      // Type a prompt INTO the mirrored TUI (PTY), NOT via ACP session/prompt.
      await delay(TUI_BOOT_MS);
      agent.sessions[sessionId].pty.write("Reply with exactly: ok");
      setTimeout(() => agent.sessions[sessionId].pty.write("\r"), SUBMIT_DELAY_MS);

      let to: ReturnType<typeof setTimeout> | undefined;
      const got = await Promise.race([
        sawAgentMessage.then(() => true),
        new Promise<boolean>((res) => {
          to = setTimeout(() => res(false), TURN_TIMEOUT_MS);
        }),
      ]);
      if (to) clearTimeout(to);

      assert.ok(got, `no agent_message_chunk surfaced within ${TURN_TIMEOUT_MS}ms`);
      assert.ok(
        captured.some((c) => c.update?.sessionUpdate === "agent_message_chunk"),
        "the TUI-driven turn rendered at least one agent-message update in the panel stream",
      );
      // READ-ONLY: every captured item is a session/update notification — the agent never prompts back.
      assert.ok(
        captured.every((c) => typeof c.update?.sessionUpdate === "string"),
        "the captured stream is input-free: only session/update notifications, no ACP session/prompt",
      );
      t.diagnostic(`captured ${captured.length} session/update notifications for the TUI turn`);
    } finally {
      // Integration cleanup: kill the session PTY (and its claude child) before disposing so the
      // node event loop can drain. A lingering external TUI still keeps a handle open — run with
      // --test-force-exit (see runner note above) so the process exits cleanly after the test passes.
      try {
        if (sessionId) agent.sessions[sessionId]?.pty?.kill?.();
      } catch {
        /* already gone */
      }
      await agent.dispose().catch(() => {});
    }
  },
);
