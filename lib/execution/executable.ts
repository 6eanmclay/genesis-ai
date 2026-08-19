import type { Permission } from "@/lib/permissions";
import type { ActorType } from "./types";

export interface ExecutionContext {
  storeId: string;
  userId: string | null;
  actorType: ActorType;
  // Phase 0 (integrations) — the id of the ExecutionLog row this run writes.
  // An OAuth connector signs it into the `state` it hands the provider, so the
  // callback closes ITS OWN attempt instead of guessing at "the most recent
  // PENDING row for this action" — the guess that left 18 orphaned rows on one
  // real store. Additive and read-only; nothing existing consults it.
  //
  // Optional deliberately: execute() always sets it, but several existing
  // verification scripts construct a context by hand and have no execution to
  // name. Requiring it would have forced edits across five unrelated files to
  // satisfy the compiler rather than to fix anything.
  executionId?: string;
}

// The thing an individual action implements — analogous to
// IntegrationConnector from PH-02, but for "any action" rather than "any
// integration." See lib/execution/adapters/integrationExecutable.ts for how
// the two compose.
export interface Executable<TInput, TMetadata = unknown> {
  action: string;
  // null = no permission check (SYSTEM-only actions, e.g. a future webhook
  // executable — nothing uses this yet, reserved the same way PH-01
  // reserved permissions ahead of their first use).
  requiredPermission: Permission | null;

  // Does the work; throws on hard failure (the engine catches it and turns
  // it into a FAILED result). Returns facts, not a finished ExecutionResult
  // — the engine builds that.
  run(
    input: TInput,
    ctx: ExecutionContext
  ): Promise<{
    message: string;
    metadata?: TMetadata;
    retryable?: boolean;
    // Present => this run's outcome is PENDING, not SUCCESS (e.g. an OAuth
    // redirect handoff that isn't finished yet).
    redirectUrl?: string;
    // Also => PENDING, not SUCCESS, for non-redirect non-terminal outcomes
    // (e.g. a form-based connector's first call, which completed nothing —
    // it just discovered what input is needed next).
    pending?: boolean;
    // => PARTIAL, not SUCCESS — the run did real work but only some of it
    // succeeded (e.g. 2 of 3 generated items). No concrete Executable
    // produces this yet as of PH-07 Layer 4; added to the vocabulary now
    // so a future multi-part action doesn't need this contract to change.
    partial?: boolean;
  }>;

  // Optional independent re-check that the effect actually stuck (Stripe's
  // charges_enabled check). Omit for executables where the write itself is
  // the only truth available (e.g. a straight Prisma toggle).
  verify?(
    input: TInput,
    ctx: ExecutionContext
  ): Promise<{ ok: boolean; error?: string }>;
}
