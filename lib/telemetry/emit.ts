import { prismaSystem } from "@/lib/prisma";
import { correlationId } from "@/lib/observability/correlation";
import { EVENTS, type ActorKind, type EventName } from "./taxonomy";

// THE TYPED WAY TO SAY SOMETHING HAPPENED.
//
// ============ WHY NOT logProductEvent (2026-08-30) =====================
//
// It is unchanged and still used by the six product-analytics call sites that
// predate this: chat turns, approvals, navigation, the journey stage. Those
// answer "what was the person doing" and their shape is right for that.
//
// This is the systems half. It differs in four ways that matter:
//
//   the name is a KEY IN A REGISTRY, not a string. An event that cannot state
//     its purpose does not get emitted.
//   metadata is ALLOWLISTED per event, so the next person cannot casually put a
//     customer address in a table nobody prunes.
//   subsystem and actorKind are recorded, so "which system, set going by whom"
//     is answerable without inferring it from a null userId.
//   it needs no session. Storage, jobs and webhooks have no sessionInstanceId
//     and were structurally unable to use the old entry point at all — which is
//     a large part of why they emitted nothing.
//
// ============ IT NEVER BREAKS WHAT IT OBSERVES ========================
//
// Swallowed failures, no await required by any caller for correctness. A
// telemetry write that fails must produce a missing row, never a failed upload.

/** Storage, jobs and crons have no browser session. Named so it is obviously not one. */
const NO_SESSION = "system";

export interface EmitInput {
  name: EventName;
  actorKind: ActorKind;
  storeId?: string | null;
  userId?: string | null;
  outcome?: "success" | "failure" | "abandoned" | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
  /** Groups repeated attempts at one logical thing. */
  attemptKey?: string | null;
  sessionInstanceId?: string | null;
}

/**
 * Keep only the keys this event declared.
 *
 * DROPS, does not throw. A developer who adds an undeclared key gets a missing
 * field in a dashboard; throwing would let a telemetry mistake break a
 * checkout, which is the opposite of the trade this system should make.
 */
function allowedMetadata(name: EventName, metadata: Record<string, unknown> | null | undefined) {
  if (!metadata) return null;
  const allowed = EVENTS[name].metadataKeys as readonly string[];
  const kept: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in metadata && metadata[key] !== undefined) kept[key] = metadata[key];
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

export async function emit(input: EmitInput): Promise<void> {
  try {
    const definition = EVENTS[input.name];
    await prismaSystem.productEvent.create({
      data: {
        name: input.name,
        // The product-analytics taxonomy still has to be satisfied; systems
        // events are not a thing a person was doing, so they are all
        // "performance" — the one declared category that had never fired, and
        // whose meaning ("how is the system behaving") is exactly this.
        category: "performance",
        subsystem: definition.subsystem,
        actorKind: input.actorKind,
        storeId: input.storeId ?? null,
        userId: input.userId ?? null,
        sessionInstanceId: input.sessionInstanceId ?? NO_SESSION,
        outcome: input.outcome ?? null,
        durationMs: input.durationMs ?? null,
        attemptKey: input.attemptKey ?? null,
        correlationId: correlationId(),
        ...(allowedMetadata(input.name, input.metadata)
          ? { metadata: allowedMetadata(input.name, input.metadata) as object }
          : {}),
      },
    });
  } catch {
    // Deliberately silent. See the header: a telemetry failure must be a
    // missing row, never a failed upload — and reporting it would turn one
    // unavailable database into two errors on the same request.
  }
}

/** Fire and forget, for a hot path that must not wait on an insert. */
export function emitAsync(input: EmitInput): void {
  void emit(input);
}
