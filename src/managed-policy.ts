import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

/**
 * Applies the managed-policy tier's env vars to `process.env` before any SDK
 * call, so the spawned CLI inherits them. Going through `resolveSettings`
 * rather than a raw read of `managed-settings.json` also picks up MDM sources on
 * macOS and `HKLM`/`HKCU` on Windows.
 *
 * Port of upstream #1146 (58c5db1). Reading the tier is best-effort by nature:
 * on a host with no MDM and no managed policy the result is empty and the agent
 * behaves identically. So a transient failure to read it — `EINTR`, `EMFILE`,
 * `EAGAIN` — must leave the agent running with no policy env rather than stop
 * it from starting.
 *
 * That guard matters because index.ts awaits this at module scope in an ESM
 * entry point, before its `unhandledRejection` handler exists, where a
 * rejection aborts module evaluation and the process exits before serving any
 * ACP traffic. `SettingsManager` (settings.ts) wraps the same SDK call for the
 * same reason.
 */
export async function applyManagedPolicyEnv(
  resolve: typeof resolveSettings = resolveSettings,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  let policy: Awaited<ReturnType<typeof resolveSettings>>;
  try {
    policy = await resolve({ settingSources: [] });
  } catch (error) {
    // stderr, so the ACP stream on stdout stays clean.
    console.error("Failed to resolve managed policy settings:", error);
    return;
  }
  for (const [key, value] of Object.entries(policy.effective.env ?? {})) {
    env[key] = value;
  }
}
