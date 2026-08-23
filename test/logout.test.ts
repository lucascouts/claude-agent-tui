import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// Story 062 / Task 1.1 — the ACP `logout` method (acp-sdk 1.0.0).
//
// acp-sdk 1.0.0 declares an optional Agent method `logout` and dispatches the
// `logout` wire method to the handler named EXACTLY `logout` (no `unstable_`
// prefix). The SDK registration gate is
// (node_modules/@agentclientprotocol/sdk/dist/acp.js:999):
//
//     if (implementation.logout) {
//         app.onRequest(AGENT_METHODS.logout,
//                       async (ctx) => (await implementation.logout(ctx.params)) ?? {});
//     }
//
// Under the PTY engine, `logout` means "drop the in-memory `gatewayAuthRequest`
// and re-offer auth on the next initialize" — it must NOT touch on-disk
// credentials (~/.claude, the billing seam — R2) and must NOT bridge to the PTY
// (R3). It is idempotent (R4), leaves active sessions running (R6), and
// `dispose()` clears the same intent (R7).
//
// Hermetic by design: inspects the public class surface + in-memory state only —
// no PTY, no SDK private state. The no-fs assertion redirects HOME to an empty
// tempdir and proves nothing is created/removed there (the runner does not enable
// `--experimental-test-module-mocks`, so the fs module cannot be module-mocked).

function freshAgent() {
  // Same construction the 061 wire suite and the initialize-purity suite use:
  // an empty client stub is sufficient to inspect the handler surface and the
  // in-memory auth intent (no engine/session/PTY).
  return new ClaudeAcpAgent({}, console);
}

test("logout wire: handler is named logout (no unstable_ prefix)", () => {
  const agent = freshAgent();
  assert.equal(
    typeof agent.logout,
    "function",
    "acp-sdk 1.0.0 dispatches logout → implementation.logout",
  );
  assert.equal(
    agent.unstable_logout,
    undefined,
    "logout carries no unstable_ prefix (acp.d.ts:1646)",
  );
});

test("logout wire: SDK registration gate selects the handler", () => {
  const agent = freshAgent();
  // Mirror the SDK's bind logic: it registers `logout` ONLY when
  // `implementation.logout` is present (acp.js:999). A missing/prefixed name
  // leaves it unbound and the client gets a silent no-op.
  let registered = null;
  const app = {
    onRequest: (method) => {
      registered = method;
    },
  };
  if (agent.logout) {
    app.onRequest("logout", (ctx) => agent.logout(ctx.params));
  }
  assert.equal(
    registered,
    "logout",
    "logout must register because implementation.logout is present",
  );
});

test("logout clears gatewayAuthRequest and returns empty/void (R1, R1.1)", async () => {
  const agent = freshAgent();
  agent.gatewayAuthRequest = { methodId: "gateway" };
  const result = await agent.logout({});
  assert.equal(
    agent.gatewayAuthRequest,
    undefined,
    "logout must clear the in-memory auth intent",
  );
  assert.ok(
    result === undefined || (typeof result === "object" && result !== null),
    "logout returns void or an empty response object",
  );
});

test("logout is idempotent with no prior authenticate (R4)", async () => {
  const agent = freshAgent();
  await assert.doesNotReject(
    agent.logout({}),
    "logout with no prior auth is a no-op, not an error",
  );
  assert.equal(agent.gatewayAuthRequest, undefined);
});

test("logout leaves active sessions running (R6)", async () => {
  const agent = freshAgent();
  const sentinel = { engine: { isDisposed: false } };
  agent.sessions = { "s-1": sentinel };
  await agent.logout({});
  assert.equal(
    agent.sessions["s-1"],
    sentinel,
    "logout must not tear down active sessions (logout != shutdown)",
  );
});

test("dispose clears gatewayAuthRequest (R7)", async () => {
  const agent = freshAgent();
  agent.sessions = {};
  agent.gatewayAuthRequest = { methodId: "gateway" };
  await agent.dispose();
  assert.equal(
    agent.gatewayAuthRequest,
    undefined,
    "dispose must clear the in-memory auth intent",
  );
});

test("logout performs no credential filesystem I/O (R2)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logout-nofs-"));
  const savedHome = process.env.HOME;
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = tmp;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, ".claude");
  try {
    const agent = freshAgent();
    agent.gatewayAuthRequest = { methodId: "gateway" };
    await agent.logout({});
    assert.deepEqual(
      fs.readdirSync(tmp),
      [],
      "logout must not read/write/delete any credential file under HOME",
    );
  } finally {
    process.env.HOME = savedHome;
    if (savedCfg === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedCfg;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Story 062 live-proof seam (FORK_AUTH_PROBE) -------------------------------------
//
// The tests above can only SIMULATE the SDK bind, so none of them prove that a real
// client reaches the handler over the wire. The probe below is what makes that
// observable during the manual Zed proof; these cases pin its contract: OFF by default,
// stderr-only, and never echoing the payload (gateway credentials).

async function captureStderrAsync(fn) {
  const saved = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = saved;
  }
  return chunks.join("");
}

async function withProbeEnv(value, fn) {
  const saved = process.env.FORK_AUTH_PROBE;
  if (value === undefined) {
    delete process.env.FORK_AUTH_PROBE;
  } else {
    process.env.FORK_AUTH_PROBE = value;
  }
  try {
    return await fn();
  } finally {
    if (saved === undefined) {
      delete process.env.FORK_AUTH_PROBE;
    } else {
      process.env.FORK_AUTH_PROBE = saved;
    }
  }
}

test("logout probe is silent when FORK_AUTH_PROBE is unset (default OFF)", async () => {
  const out = await withProbeEnv(undefined, () =>
    captureStderrAsync(async () => {
      await freshAgent().logout({});
    }),
  );
  assert.equal(out, "", "the probe must stay off unless explicitly opted in");
});

test("logout probe is silent when FORK_AUTH_PROBE is not exactly \"1\"", async () => {
  const out = await withProbeEnv("0", () =>
    captureStderrAsync(async () => {
      await freshAgent().logout({});
    }),
  );
  assert.equal(out, "", "only the exact value \"1\" enables the probe");
});

test("logout probe emits one tagged stderr line when FORK_AUTH_PROBE=1", async () => {
  const out = await withProbeEnv("1", () =>
    captureStderrAsync(async () => {
      await freshAgent().logout({});
    }),
  );
  assert.match(
    out,
    /^\[auth-probe] logout dispatched by the client\n$/,
    "the live proof reads this exact line to confirm wire dispatch",
  );
});

test("logout probe never echoes the payload (credential safety)", async () => {
  const secret = "gw-token-do-not-log";
  const out = await withProbeEnv("1", () =>
    captureStderrAsync(async () => {
      await freshAgent().logout({ methodId: "gateway", token: secret });
    }),
  );
  assert.ok(
    !out.includes(secret),
    "_params may carry gateway credentials — the probe must never log it",
  );
});

test("logout probe does not change the handler's contract (R1, R4)", async () => {
  await withProbeEnv("1", async () => {
    const agent = freshAgent();
    agent.gatewayAuthRequest = { methodId: "gateway" };
    const out = await captureStderrAsync(async () => {
      const result = await agent.logout({});
      assert.ok(result === undefined || (typeof result === "object" && result !== null));
      await agent.logout({}); // still idempotent with the probe on
    });
    assert.equal(agent.gatewayAuthRequest, undefined, "clearing still happens with the probe on");
    assert.equal(
      out.match(/\[auth-probe]/g).length,
      2,
      "one line per dispatch — the proof counts calls",
    );
  });
});
