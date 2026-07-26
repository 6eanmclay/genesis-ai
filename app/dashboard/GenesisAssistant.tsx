"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useFormStatus } from "react-dom";
import { deriveGenesisState, type GenesisState } from "@/lib/dashboard/genesisState";
import { SubmitButton } from "./SubmitButton";

type Message = {
  id: string;
  role: string;
  content: string;
  changes: unknown;
};

// The one place a GenesisState becomes a visual — "idle" renders nothing,
// the rest render a small colored dot. Swapping this for a richer future
// visual (the G-ring) only means changing this map, not the state logic in
// lib/dashboard/genesisState.ts.
const GENESIS_STATE_DOT: Record<GenesisState, { className: string; title: string } | null> = {
  idle: null,
  working: { className: "animate-pulse bg-blue-500", title: "Genesis is working" },
  needs_decision: { className: "bg-amber-400", title: "Something needs your decision" },
  opportunity: { className: "bg-purple-500", title: "Genesis found an opportunity" },
  urgent: { className: "animate-pulse bg-red-500", title: "Genesis needs you" },
};

function StateDot({ state }: { state: GenesisState }) {
  const dot = GENESIS_STATE_DOT[state];
  if (!dot) return null;
  return <span className={`h-2 w-2 shrink-0 rounded-full ${dot.className}`} aria-hidden="true" title={dot.title} />;
}

// Reads the enclosing <form>'s real pending state — must render as a
// descendant of the <form>, which is why the whole panel below (not just
// the input row) is wrapped in one form. useFormStatus is the only way to
// know "working" is true; it can't be lifted to a prop, so this is the
// second of two call sites into deriveGenesisState (the closed pill below
// is the other) rather than one shared computation up front.
interface GenesisSignals {
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
}

function GenesisStatusDot({ hasUrgentIssue, hasPendingDecision, hasOpportunity }: GenesisSignals) {
  const { pending } = useFormStatus();
  const state = deriveGenesisState({ isWorking: pending, hasUrgentIssue, hasPendingDecision, hasOpportunity });
  return <StateDot state={state} />;
}

export function GenesisAssistant({
  storeName,
  messages,
  sendMessage,
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
}: {
  storeName: string;
  messages: Message[];
  sendMessage: (formData: FormData) => void;
} & GenesisSignals) {
  const [open, setOpen] = useState(messages.length > 0);
  const pathname = usePathname();

  if (!open) {
    // No form is mounted while closed, so "working" is structurally
    // impossible here — isWorking is always false, not a placeholder.
    const closedState = deriveGenesisState({ isWorking: false, hasUrgentIssue, hasPendingDecision, hasOpportunity });
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-[var(--brand-accent,var(--foreground))] px-5 py-3 text-sm font-medium text-white shadow-xl transition-transform hover:scale-105"
      >
        <StateDot state={closedState} />
        ✨ Genesis
      </button>
    );
  }

  return (
    <form
      action={sendMessage}
      className="fixed bottom-6 right-6 z-50 flex w-96 max-w-[calc(100vw-3rem)] flex-col rounded-2xl border border-black/[.08] bg-white shadow-xl dark:border-white/[.145] dark:bg-zinc-900"
    >
      <input type="hidden" name="currentPath" value={pathname} />

      <div className="flex items-start justify-between border-b border-black/[.08] p-4 dark:border-white/[.145]">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-[var(--font-heading,inherit)] font-semibold text-black dark:text-zinc-50">
              How can Genesis bring your vision to life?
            </p>
            <GenesisStatusDot
              hasUrgentIssue={hasUrgentIssue}
              hasPendingDecision={hasPendingDecision}
              hasOpportunity={hasOpportunity}
            />
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Your creative partner for {storeName}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="text-zinc-400 hover:text-black dark:hover:text-zinc-50"
        >
          ✕
        </button>
      </div>

      <div className="flex max-h-80 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            <p className="font-medium text-black dark:text-zinc-50">
              Need help refining your store?
            </p>
            <p className="mt-1">
              Ask Genesis to improve your branding, design, products, or
              anything else.
            </p>
          </div>
        ) : (
          messages.map((m) => {
            const changes = m.changes as string[] | null;
            return (
              <div
                key={m.id}
                className={
                  m.role === "user"
                    ? "self-end rounded-lg bg-foreground px-3 py-2 text-sm text-background"
                    : "self-start rounded-lg border border-black/[.08] bg-zinc-50 px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-800 dark:text-zinc-50"
                }
              >
                <p>{m.content}</p>
                {changes && changes.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs opacity-60 hover:opacity-100">
                      See what changed
                    </summary>
                    <ul className="mt-1 list-disc pl-4 text-xs opacity-75">
                      {changes.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-black/[.08] p-4 dark:border-white/[.145]">
        <textarea
          name="message"
          placeholder="Tell Genesis what you'd like to change…"
          rows={2}
          required
          className="rounded-lg border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
        <SubmitButton
          pendingText="Genesis is thinking..."
          className="self-start rounded-full bg-[var(--brand-accent,var(--foreground))] px-4 py-1.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Ask Genesis
        </SubmitButton>
      </div>
    </form>
  );
}
