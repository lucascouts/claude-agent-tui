// === SEAM(011): engine boundary — temporary no-op stub ===
// Story 011 inserts a TEMPORARY no-op engine at the reuse/rewrite seam mapped by
// story 010 (fork/SEAM-MAP.md): the SDK-coupled `createSession()` + the ~590-line
// `prompt()` loop are CUT (→ story 023, the core rewrite). This module lets the ACP
// agent boot end-to-end WITHOUT the credit-billing SDK `query()` path while the real
// PTY + JSONL-tail engine is built in stories 013–015/023.
//
// It imports NOTHING — in particular nothing from `@anthropic-ai/claude-agent-sdk`
// — so no billed path is reachable through the engine seam (story 011 Task 2.2).
// Degrau 1 is READ-ONLY: `session/prompt` is not wired ACP-side, so the stub's work
// methods are never reached in normal operation; if they ever are, they reject
// loudly rather than silently no-op, keeping failures legible.

/**
 * The engine boundary the ACP layer delegates session/turn work to. The methods
 * mirror the CUT symbols in fork/SEAM-MAP.md (`createSession`, `prompt` → 023). The
 * real implementation (PTY spawn + JSONL tail) arrives in 013–015/023; story 011
 * ships only this contract plus the no-op stub below. Params/returns are `unknown`
 * on purpose — the concrete shapes are defined by the 023 rewrite, not pinned here.
 */
export interface Engine {
  /** Discriminator for diagnostics/tests (e.g. "stub" vs the future "pty"). */
  readonly kind: string;
  /** Create an engine-backed session. CUT in 011 (→ 023). */
  createSession(params: unknown): Promise<unknown>;
  /** Run one prompt turn. CUT in 011 (→ 023). */
  prompt(params: unknown): Promise<unknown>;
}

/** Error message thrown when 011's READ-ONLY stub is asked to do real engine work. */
export const ENGINE_NOT_IMPLEMENTED_011 = "engine not implemented in 011 (read-only Degrau 1)";

/**
 * No-op engine: boots cleanly, performs no SDK/PTY work, and rejects any real engine
 * call with a legible error. Temporary scaffolding — replaced by the PTY engine in
 * stories 013–015/023.
 */
export class StubEngine implements Engine {
  readonly kind = "stub";

  async createSession(): Promise<never> {
    throw new Error(ENGINE_NOT_IMPLEMENTED_011);
  }

  async prompt(): Promise<never> {
    throw new Error(ENGINE_NOT_IMPLEMENTED_011);
  }
}

/** Factory for the default story-011 engine (the no-op stub). */
export function createStubEngine(): Engine {
  return new StubEngine();
}
