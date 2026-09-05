// Story 009 / Task 8.2 — the reachable half of upstream `#1079` (`da9f7e5`), R7.3/R7.4.
//
// WHY THIS IS A MODULE OF ITS OWN. Same convention as the rest of this fork's ports: a
// self-contained file that imports nothing from `acp-agent.ts`, so the next upstream sync pays
// no merge cost against a file that moves almost daily.
//
// WHAT UPSTREAM'S COMMIT DOES. Under `--hide-claude-auth` it stops merely hiding the claude.ai
// auth METHOD and starts refusing TURNS that would bill a claude.ai subscription. Two halves:
// pure credential classification, and a turn-level guard that acts on a live turn.
//
// WHAT LANDED HERE. The classification only. See {@link CUT_FROM_UPSTREAM} — the guard needs a
// turn, and this fork's `prompt()` loop is story 011's no-op stub (`ENGINE_NOT_IMPLEMENTED_011`)
// pending the 023 rewrite. Porting a refusal with nothing to refuse would read as parity while
// doing nothing, which is exactly what R7.4 forbids.
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * R7.4 — which half of `#1079` was CUT, and why, stated where a caller will see it rather than
 * only in the ledger. §16.3 of `docs/REBASE-AND-DRIFT.md` is the long form.
 */
export const CUT_FROM_UPSTREAM = {
  commit: "da9f7e5",
  pr: 1079,
  cut: ["refuseClaudeSubscriptionTurn", "ClaudeSubscriptionGuardState"],
  why:
    "Both act on a turn in flight. This fork's engine is story 011's no-op stub — createSession() " +
    "and the ~590-line prompt() loop are CUT pending story 023 — so there is no turn to refuse. " +
    "The classification below is exact and callerless; wire it when 023 lands a turn loop.",
} as const;

/**
 * The `apiKeySource` values that outrank a stored claude.ai subscription.
 *
 * The SDK documents `ApiKeySource` as the origin of the credential used for API requests.
 * `ANTHROPIC_API_KEY` is the environment variable, `apiKeyHelper` the configured helper command,
 * and `/login managed key` a key `/login` created against an Anthropic Console account. Each is
 * an API key that pays INSTEAD of the subscription. Every other member means no API key is in
 * use: `none`, and the legacy `user`/`project`/`org`/`temporary`/`oauth` current CLIs never emit.
 */
const API_KEY_SOURCES_ABOVE_SUBSCRIPTION: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "apiKeyHelper",
  "/login managed key",
]);

/**
 * True when a turn on this account is paid by a claude.ai subscription.
 *
 * The SDK types `apiKeySource` and `tokenSource` as open strings, so this is an ALLOWLIST: an
 * account bills the subscription only when every field proves it, and an unknown value keeps the
 * guard on rather than assuming the safe case.
 *
 * - `subscriptionType` must be set — without it the CLI reports no subscription.
 * - `tokenSource` must be absent — the CLI sets it in place of the subscription when a bearer or
 *   OAuth environment token pays for the turn.
 * - `apiProvider` must be absent or `firstParty` — the Anthropic OAuth login applies only there;
 *   for `bedrock`, `vertex`, `foundry` or `gateway` the other fields are absent and auth is
 *   external.
 * - `apiKeySource` must not be one of {@link API_KEY_SOURCES_ABOVE_SUBSCRIPTION} — credential
 *   precedence puts those above the `/login` subscription, so the key pays and the stored
 *   subscription is inert.
 */
export function billsClaudeSubscription(account: AccountInfo | undefined): boolean {
  if (!account?.subscriptionType) {
    return false;
  }
  if (account.tokenSource) {
    return false;
  }
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
    return false;
  }
  return !API_KEY_SOURCES_ABOVE_SUBSCRIPTION.has(account.apiKeySource ?? "");
}

/**
 * True when the account already holds a credential this integration accepts: a third-party
 * backend, a bearer/OAuth environment token, or one of the API key sources in
 * {@link API_KEY_SOURCES_ABOVE_SUBSCRIPTION}.
 *
 * False therefore covers BOTH the signed-out CLI and the account whose only credential is a
 * claude.ai subscription. {@link billsClaudeSubscription} runs first and separates the two, so a
 * caller reaching `false` here is looking at a session with no way to pay.
 */
export function holdsNonSubscriptionCredential(account: AccountInfo | undefined): boolean {
  if (!account) {
    return false;
  }
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
    return true;
  }
  if (account.tokenSource) {
    return true;
  }
  return API_KEY_SOURCES_ABOVE_SUBSCRIPTION.has(account.apiKeySource ?? "");
}
