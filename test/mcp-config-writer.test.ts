// Story 057 / Task 2.1 — unit tests for the ACP→claude `--mcp-config` translator + 0600 scratch seam.
//
// Covers translateMcpServers (PURE: per-transport mapping, header/env array→object, empty-field
// omission, acp drop, empty/undefined input) and the writeMcpScratch/removeMcpScratch file seam
// (0600 mode, fork-acp-mcp path, JSON round-trip, idempotent removal). Behavioural imports resolve
// against ../dist, so `npm run build` (tsc) MUST run first.
//
// node:test runner:
//   node --experimental-strip-types --test test/mcp-config-writer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  translateMcpServers,
  writeMcpScratch,
  removeMcpScratch,
} from "../dist/mcp-config-writer.js";

// ── translateMcpServers — per-transport mapping ──────────────────────────────────────────────────

test("http → { type:'http', url, headers:{...} } (HttpHeader[] → object)", () => {
  const out = translateMcpServers([
    {
      type: "http",
      name: "remote",
      url: "https://mcp.example.com/api",
      headers: [
        { name: "Authorization", value: "Bearer s3cret" },
        { name: "X-Tenant", value: "acme" },
      ],
    },
  ]);
  assert.deepEqual(out, {
    mcpServers: {
      remote: {
        type: "http",
        url: "https://mcp.example.com/api",
        headers: { Authorization: "Bearer s3cret", "X-Tenant": "acme" },
      },
    },
  });
});

test("sse → { type:'sse', url, headers:{...} }", () => {
  const out = translateMcpServers([
    {
      type: "sse",
      name: "events",
      url: "https://mcp.example.com/sse",
      headers: [{ name: "Authorization", value: "Bearer tok" }],
    },
  ]);
  assert.deepEqual(out, {
    mcpServers: {
      events: {
        type: "sse",
        url: "https://mcp.example.com/sse",
        headers: { Authorization: "Bearer tok" },
      },
    },
  });
});

test("stdio → { command, args, env:{...} } and emits NO `type` field", () => {
  const out = translateMcpServers([
    {
      // NOTE: the stdio variant carries NO `type` discriminator.
      name: "local",
      command: "/usr/bin/my-mcp",
      args: ["--port", "0", "--verbose"],
      env: [
        { name: "API_KEY", value: "k-123" },
        { name: "DEBUG", value: "1" },
      ],
    },
  ]);
  assert.deepEqual(out, {
    mcpServers: {
      local: {
        command: "/usr/bin/my-mcp",
        args: ["--port", "0", "--verbose"],
        env: { API_KEY: "k-123", DEBUG: "1" },
      },
    },
  });
  // Explicitly assert stdio infers transport from `command` (no `type` key leaks through).
  assert.equal("type" in out.mcpServers.local, false);
});

// ── translateMcpServers — empty-field omission ───────────────────────────────────────────────────

test("http with empty headers OMITS the `headers` key", () => {
  const out = translateMcpServers([
    { type: "http", name: "bare", url: "https://h.example.com", headers: [] },
  ]);
  assert.deepEqual(out.mcpServers.bare, { type: "http", url: "https://h.example.com" });
  assert.equal("headers" in out.mcpServers.bare, false);
});

test("stdio with empty args AND empty env OMITS both keys", () => {
  const out = translateMcpServers([{ name: "minimal", command: "mcp-bin", args: [], env: [] }]);
  assert.deepEqual(out.mcpServers.minimal, { command: "mcp-bin" });
  assert.equal("args" in out.mcpServers.minimal, false);
  assert.equal("env" in out.mcpServers.minimal, false);
});

// ── translateMcpServers — acp drop ───────────────────────────────────────────────────────────────

test("an acp-type server is DROPPED (absent from the output)", () => {
  const out = translateMcpServers([
    { type: "acp", name: "viaAcp", id: "acp-server-1" },
    { name: "kept", command: "mcp-bin", args: [], env: [] },
  ]);
  assert.equal("viaAcp" in out.mcpServers, false);
  assert.deepEqual(Object.keys(out.mcpServers), ["kept"]);
  assert.deepEqual(out.mcpServers.kept, { command: "mcp-bin" });
});

// ── translateMcpServers — empty / undefined input never throws ───────────────────────────────────

test("empty array input → { mcpServers: {} } (no throw)", () => {
  assert.deepEqual(translateMcpServers([]), { mcpServers: {} });
});

test("undefined input → { mcpServers: {} } (no throw)", () => {
  assert.deepEqual(translateMcpServers(undefined), { mcpServers: {} });
});

test("a mixed array translates each transport and drops only the acp one", () => {
  const out = translateMcpServers([
    { type: "http", name: "h", url: "https://h", headers: [{ name: "A", value: "1" }] },
    { type: "sse", name: "s", url: "https://s", headers: [] },
    { type: "acp", name: "dropped", id: "x" },
    { name: "io", command: "bin", args: ["--x"], env: [] },
  ]);
  assert.deepEqual(out, {
    mcpServers: {
      h: { type: "http", url: "https://h", headers: { A: "1" } },
      s: { type: "sse", url: "https://s" },
      io: { command: "bin", args: ["--x"] },
    },
  });
});

// ── writeMcpScratch / removeMcpScratch — file seam ───────────────────────────────────────────────

test("writeMcpScratch writes a 0600 file at a fork-acp-mcp path that round-trips the config", async () => {
  const config = {
    mcpServers: {
      remote: {
        type: "http" as const,
        url: "https://mcp.example.com",
        headers: { Authorization: "Bearer s3cret" },
      },
    },
  };
  let scratchPath: string | undefined;
  try {
    scratchPath = await writeMcpScratch(config);

    // path is uuid-namespaced under the temp dir and carries the fork sentinel.
    assert.ok(scratchPath.includes("fork-acp-mcp"), `path missing sentinel: ${scratchPath}`);
    assert.ok(existsSync(scratchPath), "scratch file should exist after writeMcpScratch");

    // mode is EXACTLY 0600 (owner rw only) — secrets may ride in the file (R2.3).
    assert.equal(statSync(scratchPath).mode & 0o777, 0o600);

    // contents round-trip: parsing the file deep-equals the config we wrote.
    assert.deepEqual(JSON.parse(readFileSync(scratchPath, "utf8")), config);
  } finally {
    if (scratchPath !== undefined) {
      await removeMcpScratch(scratchPath);
    }
  }
});

test("two writeMcpScratch calls produce DISTINCT (uuid-namespaced) paths", async () => {
  const cfg = { mcpServers: {} };
  let a: string | undefined;
  let b: string | undefined;
  try {
    a = await writeMcpScratch(cfg);
    b = await writeMcpScratch(cfg);
    assert.notEqual(a, b);
  } finally {
    if (a !== undefined) await removeMcpScratch(a);
    if (b !== undefined) await removeMcpScratch(b);
  }
});

test("removeMcpScratch unlinks the file (gone afterward) and is idempotent", async () => {
  const scratchPath = await writeMcpScratch({ mcpServers: {} });
  assert.ok(existsSync(scratchPath), "precondition: file exists");

  await removeMcpScratch(scratchPath);
  assert.equal(existsSync(scratchPath), false, "file should be gone after removeMcpScratch");

  // Idempotent: a second remove of the now-missing path must NOT throw.
  await removeMcpScratch(scratchPath);
  // And removing an entirely unknown/never-created path must NOT throw either.
  await removeMcpScratch(`${scratchPath}.does-not-exist`);
});
