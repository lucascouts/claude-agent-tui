// Story 055 / Task 1.3 — the per-session token is appended to the hook URL AFTER the marker path,
// and the tokenized URL MUST still be recognized by teardown (isForkHookGroup) so `restore` surgically
// removes the fork group (R1.3 / Unchanged Behavior: "teardown still recognizes the tokenized URL").
//
// Authored RED-first by the Test Advisor BEFORE implementation. The contract:
//   - buildHookEntry(port, { token }) embeds the token AFTER FORK_HOOK_MARKER_PATH so the URL is
//     `http://127.0.0.1:<port>/__fork-acp-gate__/<token>`.
//   - isForkHookGroup STILL matches that tokenized group (it matches on the marker substring), so
//     teardown is forge-resistant AND token-resistant.
//
// OFFLINE pure-function test. node:test (build first), cwd=fork/:
//   node --experimental-strip-types --test test/settings-writer-token.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHookEntry,
  isForkHookGroup,
  FORK_HOOK_MARKER_PATH,
} from "../dist/gate/settings-writer.js";

const TOKEN = "9f8e7d6c5b4a3210";

test("055/1.3 buildHookEntry appends the token AFTER the marker path segment", () => {
  // The token-bearing overload: a port plus a per-session token.
  const group = buildHookEntry(45678, { token: TOKEN }) as { hooks: { url: string }[] };
  const url = group.hooks[0].url;
  assert.ok(
    url.includes(FORK_HOOK_MARKER_PATH),
    "the fork marker substring is preserved (teardown keys on it)",
  );
  assert.ok(
    url.endsWith(`${FORK_HOOK_MARKER_PATH}/${TOKEN}`),
    `the token is appended AFTER the marker — got ${url}`,
  );
});

test("055/1.3 isForkHookGroup STILL recognizes the tokenized group (teardown survives the token)", () => {
  const group = buildHookEntry(45678, { token: TOKEN });
  assert.equal(
    isForkHookGroup(group),
    true,
    "the tokenized fork group is still recognized as the fork's own (restore can surgically remove it)",
  );
});
