// The Execution & Verification Engine's universal result shape — every
// action Genesis or a merchant performs reports through this same type
// instead of inventing its own success/failure shape. See ARCHITECTURE.md.

export type ExecutionStatus = "SUCCESS" | "WARNING" | "FAILED" | "PENDING" | "PARTIAL";

export type ActorType = "USER" | "GENESIS" | "SYSTEM";

export const CURRENT_EXECUTION_SCHEMA_VERSION = 1;

export interface ExecutionResult<TMetadata = unknown> {
  // Groups rows belonging to one logical request's lifecycle (e.g. an OAuth
  // handoff's PENDING row and its later resolution row share this).
  executionId: string;
  // Stable id, e.g. "store.publish", "integration.stripe.connect" — see
  // EXECUTION_ACTIONS in ./actions.ts.
  action: string;
  status: ExecutionStatus;
  // Independently confirmed, not just "the call didn't throw" — see
  // ARCHITECTURE.md for why this is kept separate from `status`.
  verified: boolean;
  message: string;
  retryable: boolean;
  // Present only when status is PENDING via a redirect handoff (e.g. an
  // OAuth authorize URL) — the caller is responsible for actually
  // redirecting; the engine only records that it's happening.
  redirectUrl?: string;
  actorType: ActorType;
  actorId: string | null;
  // Most executions belong to a real Store; Genesis's draft-side chat
  // happens before one exists, only a StoreDraft — exactly one of the two
  // is set, mirroring the StoreGeneration model's existing dual-phase
  // pattern.
  storeId: string | null;
  storeDraftId: string | null;
  // Versions the shape of `metadata` so future code can interpret older
  // rows correctly instead of assuming today's shape forever.
  schemaVersion: number;
  timestamp: Date;
  metadata: TMetadata;
}
