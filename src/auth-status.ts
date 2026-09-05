// Story 009 / Task 8.2 — the reachable half of upstream `#1080` (`eb5ca9f`), R7.3/R7.4.
//
// WHAT UPSTREAM'S COMMIT DOES. It reports the agent's auth identity over ACP through an
// `_auth/status_update` notification, gated by an `authStatusCapability` negotiated at
// `initialize`, and probes the local CLI to build that identity.
//
// WHAT LANDED HERE. The identity model and its pure constructors. The notification did NOT — see
// {@link CUT_FROM_UPSTREAM}. That is a measurement, not a guess: `authStatus` and
// `_auth/status_update` are ZERO occurrences in the packaged Zed's `crates/` tree AND in the
// pinned `agent-client-protocol-schema-1.5.0`. No client in this chain can receive it.
//
// The half that IS here is the half a PTY bridge is better placed for than an SDK adapter: this
// fork already runs the real `claude` client, so asking that client what identity it holds is a
// local question, not a protocol one. See §16.4 of `docs/REBASE-AND-DRIFT.md`.

/**
 * R7.4 — which half of `#1080` was CUT, and why, stated where a caller will see it.
 */
export const CUT_FROM_UPSTREAM = {
  commit: "eb5ca9f",
  pr: 1080,
  cut: ["_auth/status_update", "authStatusCapability"],
  why:
    "The notification is capability-negotiated and no client in this chain negotiates it: " +
    "`authStatus` is 0 occurrences in the packaged Zed's crates/ tree and 0 in the pinned " +
    "agent-client-protocol-schema-1.5.0, so the wire type does not exist yet. This is stronger " +
    "than 'not wired': there is nowhere to send it. Reopens when the schema carries it.",
} as const;

/** How the agent is authenticated. `external` covers backends whose credentials live outside
 *  the agent entirely (AWS creds, gcloud ADC, …). */
export type AuthStatusKind = "account" | "api_key" | "gateway" | "external" | "none";

export type AuthStatus = {
  kind: AuthStatusKind;
  /** Short human-readable identity, safe to show in a picker. */
  label: string;
  /** Optional qualifier — a gateway host, an organisation, a key source. */
  detail?: string;
};

/** The signed-out identity. */
const NOT_LOGGED_IN: AuthStatus = {
  kind: "none",
  label: "Not logged in",
};

/**
 * A fresh signed-out identity.
 *
 * Returns a COPY deliberately: handing out the shared constant would let one caller's edit reach
 * every other caller, and this value is short-lived and passed around freely.
 */
export function notLoggedInAuthStatus(): AuthStatus {
  return { ...NOT_LOGGED_IN };
}

/**
 * ACP-level gateway auth (`authenticate` with `gateway` / `gateway-bedrock`). The gateway owns
 * the credentials, so it wins over anything the CLI reports.
 *
 * A malformed `baseUrl` falls back to the raw string rather than throwing: the gateway is
 * authenticated either way, and losing the identity to a URL typo would be the worse failure.
 */
export function gatewayAuthStatus(baseUrl?: string): AuthStatus {
  let host: string | undefined;
  if (baseUrl) {
    try {
      host = new URL(baseUrl).host;
    } catch {
      host = baseUrl;
    }
  }
  return {
    kind: "gateway",
    label: "Custom model gateway",
    ...(host ? { detail: host } : {}),
  };
}
