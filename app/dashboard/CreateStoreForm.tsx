"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Generation-progress UX (Phase 1 Beta Excellence checklist #2 follow-up).
// A real, measured end-to-end test confirmed the ~110s wait here is
// essentially 100% real claude-opus-4-8 generation time (two sequential
// calls — PRIMARY, then SECONDARY+COMPOSITION concurrently — app-side
// overhead is a few hundred ms, negligible) — see
// memory/project_beta_readiness_audit.md. Since quality/model settings
// stay unchanged (explicit instruction), the only honest lever left is
// making the wait feel intentional rather than frozen.
//
// Every displayed phase message maps to a *real* status transition
// generateStoreDraftCore writes to StoreDraft.status as it actually moves
// through the two real sequential calls (see that function's own
// comment) — never a fabricated sequence of steps timed by a client
// guess. Polled via a plain Route Handler (/api/draft-status), not a
// Server Action: Next.js dispatches Server Actions one at a time per
// client, so a Server Action polled while a real generation action is
// still in flight would just queue behind it and never actually run
// concurrently.
//
// The generation call itself goes through /api/generate-store-draft (also
// a plain Route Handler, not the generateStoreDraft Server Action) for a
// second, distinct reason, confirmed live: calling a Server Action
// programmatically requires wrapping it in startTransition (React's own
// documented calling convention for actions outside a <form>), but
// startTransition defers *committing* the whole component tree —
// including sibling state set outside the transition — until the
// transition itself settles. A local isGenerating flip inside that
// transition re-ran the component's render function every tick (state
// genuinely updated) but never repainted the DOM for the full ~110s the
// action was in flight, because startTransition is built for
// de-prioritizing non-urgent updates, not for keeping a UI responsive
// during one long operation. A plain fetch() has no such coupling — the
// local isGenerating flip commits immediately, fully independent of the
// fetch's own lifecycle. generateStoreDraft (the Server Action) still
// exists and still works via a plain <form action> for progressive
// enhancement with JS disabled — this component just isn't what calls it.
const PHASE_MESSAGES: Record<string, string> = {
  generating_primary: "Understanding your business & developing your brand…",
  generating_secondary: "Creating your products & building your storefront…",
  ready: "Finishing up…",
};

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function CreateStoreForm({
  resuming,
  initialStoreName,
  initialProductType,
  initialVision,
}: {
  resuming: boolean;
  initialStoreName: string;
  initialProductType: string;
  initialVision: string;
}) {
  const router = useRouter();
  const [isGenerating, setIsGenerating] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isGenerating) return;

    const startedAt = Date.now();
    const timerInterval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    let cancelled = false;
    const pollPhase = async () => {
      try {
        const res = await fetch("/api/draft-status", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { status: string | null };
        if (!cancelled && data.status) setPhase(data.status);
      } catch {
        // A transient poll failure isn't worth surfacing — the elapsed
        // timer alone still honestly communicates "this is still working,"
        // and the next poll a moment later will most likely succeed.
      }
    };
    pollPhase();
    const pollInterval = setInterval(pollPhase, 1500);

    return () => {
      cancelled = true;
      clearInterval(timerInterval);
      clearInterval(pollInterval);
    };
  }, [isGenerating]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setError(null);
    setIsGenerating(true);

    try {
      const res = await fetch("/api/generate-store-draft", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error || "Something went wrong generating your store. Please try again.");
        setIsGenerating(false);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Couldn't reach Genesis just now. Please check your connection and try again.");
      setIsGenerating(false);
    }
  };

  if (isGenerating) {
    const message = phase ? (PHASE_MESSAGES[phase] ?? "Working on it…") : "Getting started…";
    return (
      <div className="mt-6 flex max-w-md flex-col items-start gap-2 rounded-2xl border border-black/[.08] p-6 dark:border-white/[.145]">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-foreground" aria-hidden="true" />
          <p className="text-sm font-medium text-black dark:text-zinc-50">{message}</p>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {formatElapsed(elapsedSeconds)} elapsed — this usually takes about a minute or two.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex max-w-md flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-black dark:text-zinc-50">
          Store name
        </label>
        <p className="text-xs text-zinc-500">
          Optional — If you already have a name, tell us. If not, Genesis
          will create one for you.
        </p>
        <input
          name="inputStoreName"
          type="text"
          defaultValue={initialStoreName}
          placeholder="e.g. Atlas Athletics"
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-black dark:text-zinc-50">
          What do you want to sell?
        </label>
        <p className="text-xs text-zinc-500">
          Optional — Tell us what products or services you want to offer.
        </p>
        <input
          name="inputProductType"
          type="text"
          defaultValue={initialProductType}
          placeholder="e.g. Performance gym clothing"
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-black dark:text-zinc-50">
          Describe your vision*
        </label>
        <p className="text-xs text-zinc-500">
          Required — Tell Genesis about your style, audience, colors,
          branding, and the feeling you want your store to create.
        </p>
        <textarea
          name="inputVision"
          defaultValue={initialVision}
          placeholder={`"Cozy rustic candle shop."\n"Dark luxury fitness brand."\n"Minimalist clothing company."`}
          rows={4}
          required
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <button
        type="submit"
        className="mt-2 self-start rounded-full bg-foreground px-5 py-2 text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {resuming ? "Try Again" : "Create My Store"}
      </button>
    </form>
  );
}
