import { createHmac, timingSafeEqual } from "crypto";
import type { IntegrationWebhooks, WebhookVerification } from "@/lib/integrations/types";
import type { Reconciler } from "@/lib/outbound/runOnce";

// A PROVIDER THAT DOES EXACTLY WHAT IT IS TOLD.
//
// ============ WHAT THIS PROVES, AND WHAT IT CANNOT ====================
//
// It proves OUR contracts and OUR failure handling: that a refusal is retried,
// that a silence stays indeterminate, that a forged signature is refused and
// recorded, that a duplicate is recognised, that a retry does not repeat an
// external effect.
//
// It proves NOTHING about whether Stripe, Square or Xero actually behave this
// way. A double is a statement of what we believe a provider does, and belief
// is what Connections replaces with evidence. Anything here that turns out to
// be wrong about a real provider is a bug in this file, discovered late, and
// saying so plainly is the only thing that stops a green suite reading as
// readiness. Real-provider verification is a credentials task and stays one.
//
// ============ WHY IT LIVES IN scripts/lib ============================
//
// Because it must never be reachable from production. lib/integrations is
// swept by verify-write-paths, and a fake connector sitting in the registry
// beside real ones is exactly the kind of thing that gets picked up by a
// loop over "every connector" one day. Tests construct it and hand it in.
//
// It implements the REAL interfaces — IntegrationWebhooks, Reconciler — rather
// than shapes that resemble them, so a change to a production contract breaks
// this file at compile time instead of leaving a double that quietly tests a
// version of the system that no longer exists.

/** What the double should do on the next call. */
export type Behaviour =
  | { kind: "succeed"; externalRef?: string; result?: unknown }
  /** The provider answered and refused. Nothing landed; a retry is safe. */
  | { kind: "refuse"; message?: string }
  /**
   * The call never returns an answer.
   *
   * Modelled as a hang the caller must time out on, because that is what a real
   * timeout is — not a thrown error. A thrown error is `refuse`, and conflating
   * the two is precisely the mistake that turns a timeout into a duplicate
   * charge.
   */
  | { kind: "hang"; ms?: number };

export interface CallRecord {
  operation: string;
  at: number;
}

/**
 * A scriptable provider.
 *
 * Behaviours are consumed in order and the last one repeats, so a test can say
 * "fail once then succeed" without arithmetic about how many times a retry
 * loop will call.
 */
export class ProviderDouble {
  readonly calls: CallRecord[] = [];
  private script: Behaviour[];
  /** What the provider believes it has done, for reconciliation to read. */
  readonly landed = new Map<string, string>();

  constructor(script: Behaviour[] = [{ kind: "succeed" }]) {
    this.script = [...script];
  }

  /** How many times the provider was actually reached. The instrument. */
  get callCount(): number {
    return this.calls.length;
  }

  callsTo(operation: string): number {
    return this.calls.filter((c) => c.operation === operation).length;
  }

  private next(): Behaviour {
    return this.script.length > 1 ? this.script.shift()! : this.script[0];
  }

  /**
   * Make the call.
   *
   * `idempotencyKey` is recorded against what landed so a reconciler can answer
   * the one question that resolves an indeterminate operation: did you do it?
   */
  async call(operation: string, idempotencyKey?: string): Promise<{ externalRef?: string; result?: unknown }> {
    this.calls.push({ operation, at: Date.now() });
    const behaviour = this.next();

    if (behaviour.kind === "refuse") {
      throw new Error(behaviour.message ?? "the provider refused");
    }

    if (behaviour.kind === "hang") {
      // A REAL HANG, briefly. The caller is expected to be killed or to give
      // up; nothing here resolves it into a tidy error, because a tidy error is
      // the one thing a timeout is not.
      await new Promise((resolve) => setTimeout(resolve, behaviour.ms ?? 50));
      // The provider DID the work — it just never told us. This is the state
      // that makes indeterminate dangerous and is why it is modelled at all.
      if (idempotencyKey) this.landed.set(idempotencyKey, `ref-${idempotencyKey}`);
      throw new Error("__hang__");
    }

    const ref = behaviour.externalRef ?? `ref-${this.calls.length}`;
    if (idempotencyKey) this.landed.set(idempotencyKey, ref);
    return { externalRef: ref, result: behaviour.result ?? { ok: true } };
  }

  /**
   * The provider's own answer to "did this land?".
   *
   * The contract a real connector implements during Connections. Three answers,
   * and the third is not a failure of the reconciler: a provider that cannot
   * say leaves the operation for a person, which is correct.
   */
  reconciler(mode: "honest" | "amnesiac" = "honest"): Reconciler {
    return async (key: string) => {
      if (mode === "amnesiac") return { landed: "unknown" };
      const ref = this.landed.get(key);
      return ref ? { landed: true, externalRef: ref } : { landed: false };
    };
  }

  // -------------------------------------------------------------------------
  // The webhook side
  // -------------------------------------------------------------------------

  /**
   * A real HMAC, not a stub comparison.
   *
   * A double whose "signature check" is `sig === "valid"` proves nothing about
   * whether the pipeline verifies before it trusts — it would pass just as
   * happily against a verifier that never ran. This computes and compares an
   * actual digest, in constant time, the way a provider's does.
   */
  sign(rawBody: string, secret = "double-secret"): string {
    return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  }

  webhooks(secret = "double-secret"): IntegrationWebhooks & { handled: string[]; failNext: boolean } {
    const handled: string[] = [];
    const state = { failNext: false };

    return {
      get handled() { return handled; },
      get failNext() { return state.failNext; },
      set failNext(v: boolean) { state.failNext = v; },

      verify(rawBody: string, headers: Headers): WebhookVerification {
        const provided = headers.get("x-double-signature");
        if (!provided) return { ok: false, error: "no signature header" };

        const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
        const a = Buffer.from(expected, "utf8");
        const b = Buffer.from(provided, "utf8");
        // Length first: timingSafeEqual throws on a mismatch, and a throw here
        // would be a 500 on a forged request rather than a refusal.
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return { ok: false, error: "invalid signature" };
        }

        // MALFORMED IS NOT UNSIGNED. A correctly signed body that is not JSON
        // has genuinely come from the provider, and refusing it as a signature
        // failure would put a real delivery in the attack bucket.
        try {
          const parsed = JSON.parse(rawBody) as { id?: unknown };
          return { ok: true, eventId: typeof parsed.id === "string" ? parsed.id : undefined };
        } catch {
          return { ok: true };
        }
      },

      async handle(_storeId: string, rawBody: string): Promise<void> {
        if (state.failNext) {
          state.failNext = false;
          throw new Error("handler refused this delivery");
        }
        handled.push(rawBody);
      },
    };
  }
}
