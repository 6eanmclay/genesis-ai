"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useFormStatus } from "react-dom";
import { deriveGenesisState, GENESIS_STATE_META, type GenesisState } from "@/lib/dashboard/genesisState";
import { SubmitButton } from "./SubmitButton";

// Every lg:-scoped color below is GENESIS_ATMOSPHERE (lib/dashboard/
// genesisAtmosphere.ts) written as literal hex/rgba, not imported and
// interpolated — Tailwind's class scanner works on static source text, so
// a template-literal-interpolated arbitrary value like
// `lg:bg-[${GENESIS_ATMOSPHERE.violet}]` never resolves to real CSS (the
// scanner can't see through the JS expression at build time). Keep these
// literals in sync with genesisAtmosphere.ts if that palette changes.
// bg=#07060d bgElevated=#100d1c violet=#8b7cf6 violetSoft=rgba(139,124,246,0.35)
// text=#f4f2fb textSecondary=rgba(244,242,251,0.62) border=rgba(139,124,246,0.18)

type Message = {
  id: string;
  role: string;
  content: string;
  changes: unknown;
};

// The one place a GenesisState becomes a visual on the chat pill — "idle"
// renders nothing here (this pill isn't the place "Available" needs a
// visible dot; the Genesis Language legend is), the rest read their color
// from the shared GENESIS_STATE_META so this, the Domicile, and the legend
// can never drift into three independently hand-copied palettes.
function StateDot({ state }: { state: GenesisState }) {
  if (state === "idle") return null;
  const meta = GENESIS_STATE_META[state];
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${meta.dotClassName}`}
      aria-hidden="true"
      title={meta.description}
    />
  );
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

// The contextual-review connection layer's ephemeral "why you're here"
// framing — never persisted as a StoreMessage, just constructed from data
// DashboardShell already resolved (see layout.tsx/DashboardShell.tsx).
// `kind` distinguishes a real proposal (approval — "what I recommend" is
// honest) from a raw GenesisObservation (no separate recommendation exists
// for one of those; showing "what I recommend" would fabricate one).
interface FocusedContext {
  summary: string;
  noticedSummary: string | null;
  kind: "approval" | "observation";
}

export function GenesisAssistant({
  storeName,
  messages,
  sendMessage,
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  focusedContext,
  defaultOpen,
}: {
  storeName: string;
  messages: Message[];
  sendMessage: (formData: FormData) => void;
  focusedContext?: FocusedContext | null;
  // "Welcome to Genesis" (v20) — the pre-launch draft review page wants
  // chat open by default even with zero messages yet, since talking to
  // Genesis is meant to be the primary way to shape the business, not
  // something a new user has to discover behind a closed pill.
  defaultOpen?: boolean;
} & GenesisSignals) {
  const [open, setOpen] = useState(defaultOpen || messages.length > 0 || !!focusedContext);
  const pathname = usePathname();

  // Keep the newest turn in view — on first open, and whenever a new
  // message genuinely arrives (messages.length only ever grows; there's no
  // live/streaming append mid-scroll in this architecture, since a new
  // message always means a full page render with the complete, final
  // conversation). Never fires just because the user scrolled up to read
  // history — nothing here reacts to scroll position, only to message
  // count actually changing. `current` is null while closed (this element
  // isn't rendered then), so the effect is a no-op until the panel opens.
  const messageListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  if (!open) {
    // No form is mounted while closed, so "working" is structurally
    // impossible here — isWorking is always false, not a placeholder.
    // Anchored bottom-right below lg: (unchanged); at lg:+, where Genesis
    // has a permanent left-column presence (see GenesisDomicile.tsx),
    // this repositions near/under that column instead of floating over
    // the framed Business workspace's typical content — a temporary,
    // partial mitigation only. This does not dock the panel into the
    // rail's own geometry; that redesign (conversation feeling like it
    // comes from Genesis rather than a separate widget) stays deferred.
    const closedState = deriveGenesisState({ isWorking: false, hasUrgentIssue, hasPendingDecision, hasOpportunity });
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background shadow-xl transition-transform hover:scale-105 lg:right-auto lg:left-6 lg:bg-[#8b7cf6] lg:text-white lg:shadow-[0_0_40px_-10px_rgba(139,124,246,0.35)]"
      >
        <StateDot state={closedState} />
        ✨ Genesis
      </button>
    );
  }

  // Below lg:, this whole panel is byte-identical to what's already
  // verified (plain white/zinc-900 card). At lg:+, it recolors to
  // Genesis's own atmosphere (see genesisAtmosphere.ts) so the
  // conversation reads as part of the environment rather than a
  // conventional chatbot widget floating over it — colors/typography
  // only; position, geometry, and every interaction/state behavior below
  // are completely unchanged (docking this into the rail's own shape is
  // still a separate, deferred decision).
  return (
    <form
      action={sendMessage}
      className="fixed bottom-6 right-6 z-50 flex w-96 max-w-[calc(100vw-3rem)] flex-col rounded-2xl border border-black/[.08] bg-white shadow-xl dark:border-white/[.145] dark:bg-zinc-900 lg:right-auto lg:left-6 lg:w-80 xl:w-96 lg:border-[rgba(139,124,246,0.18)] lg:bg-[#100d1c] lg:shadow-2xl"
    >
      <input type="hidden" name="currentPath" value={pathname} />

      <div className="flex items-start justify-between border-b border-black/[.08] p-4 dark:border-white/[.145] lg:border-[rgba(139,124,246,0.18)]">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-[var(--font-heading,inherit)] font-semibold text-black dark:text-zinc-50 lg:text-[#f4f2fb]">
              How can Genesis help today?
            </p>
            <GenesisStatusDot
              hasUrgentIssue={hasUrgentIssue}
              hasPendingDecision={hasPendingDecision}
              hasOpportunity={hasOpportunity}
            />
          </div>
          <p className="mt-1 text-xs text-zinc-500 lg:text-[rgba(244,242,251,0.62)]">
            Your business partner for {storeName}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="text-zinc-400 hover:text-black dark:hover:text-zinc-50 lg:text-[rgba(244,242,251,0.62)] lg:hover:text-[#f4f2fb]"
        >
          ✕
        </button>
      </div>

      <div ref={messageListRef} className="flex max-h-80 flex-col gap-3 overflow-y-auto p-4">
        {focusedContext && (
          <div className="self-start rounded-lg border border-[var(--brand-accent,var(--foreground))]/30 bg-[var(--brand-accent,var(--foreground))]/[.06] px-3 py-2 text-sm text-black dark:text-zinc-50 lg:border-[#8b7cf6]/30 lg:bg-[#8b7cf6]/10 lg:text-[#f4f2fb]">
            {focusedContext.kind === "observation" ? (
              <p>
                <span className="font-medium">What I noticed:</span> {focusedContext.summary}
              </p>
            ) : (
              <>
                {focusedContext.noticedSummary && (
                  <p>
                    <span className="font-medium">What I noticed:</span> {focusedContext.noticedSummary}
                  </p>
                )}
                <p className={focusedContext.noticedSummary ? "mt-1" : ""}>
                  <span className="font-medium">What I recommend:</span> {focusedContext.summary}
                </p>
              </>
            )}
          </div>
        )}
        {messages.length === 0 ? (
          <div className="text-sm text-zinc-600 dark:text-zinc-400 lg:text-[rgba(244,242,251,0.62)]">
            <p className="font-medium text-black dark:text-zinc-50 lg:text-[#f4f2fb]">
              Your business partner, always paying attention.
            </p>
            <p className="mt-1">
              Ask Genesis to change something, or just check in — it&apos;s
              already watching for what needs you, and will tell you what
              it&apos;s noticed or handled.
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
                    ? "self-end rounded-lg bg-foreground px-3 py-2 text-sm text-background lg:bg-[#8b7cf6] lg:text-white"
                    : "self-start rounded-lg border border-black/[.08] bg-zinc-50 px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-800 dark:text-zinc-50 lg:border-[rgba(139,124,246,0.18)] lg:bg-[#8b7cf6]/10 lg:text-[#f4f2fb]"
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

      <div className="flex flex-col gap-2 border-t border-black/[.08] p-4 dark:border-white/[.145] lg:border-[rgba(139,124,246,0.18)]">
        <textarea
          name="message"
          placeholder="Ask Genesis anything about your business…"
          rows={2}
          required
          className="rounded-lg border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50 lg:border-[rgba(139,124,246,0.18)] lg:bg-[#07060d] lg:text-[#f4f2fb] lg:placeholder:text-[rgba(244,242,251,0.62)]"
        />
        <SubmitButton
          pendingText="Genesis is thinking..."
          className="self-start rounded-full bg-[var(--brand-accent,var(--foreground))] px-4 py-1.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50 lg:bg-[#8b7cf6]"
        >
          Ask Genesis
        </SubmitButton>
      </div>
    </form>
  );
}
