"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { usePathname } from "next/navigation";
import { useFormStatus } from "react-dom";
import { deriveAssessmentState, GENESIS_STATE_META, type GenesisState } from "@/lib/dashboard/genesisState";
import { setGenesisComposing, setGenesisWorking } from "@/lib/dashboard/genesisActivity";
import { USAGE_CEILING_MESSAGE } from "@/lib/dashboard/genesisModelMessages";
import { callGenesisAction } from "@/lib/dashboard/submitGenesisAction";
import { SubmitButton } from "./SubmitButton";

// Hydration-safe read of the same lg: breakpoint (1024px) this codebase
// already uses everywhere else — useSyncExternalStore (not useState+effect)
// is the correct tool here: it gives server and the first client render the
// same value (false, via getServerSnapshot) with zero mismatch warning, then
// reacts automatically if the viewport crosses the breakpoint, without ever
// calling setState from an effect.
function subscribeToDesktopWidth(onChange: () => void) {
  const mql = window.matchMedia("(min-width: 1024px)");
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
function getIsDesktopSnapshot() {
  return window.matchMedia("(min-width: 1024px)").matches;
}
function getIsDesktopServerSnapshot() {
  return false;
}

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
// renders nothing here (this pill isn't the place "Peace" needs a visible
// dot; the Genesis Language legend is), the rest read their color from the
// shared GENESIS_STATE_META so this, the Domicile, and the legend can never
// drift into independently hand-copied palettes.
//
// isWorking is a fully separate, additive concern (Genesis Language v2 —
// see memory project_genesis_language_model.md): it never changes which
// color renders, only whether a pulsing ring is layered on top of it. A
// real request in flight must never hide a real assessment (a pending
// decision, an urgent issue) behind a blue "working" dot the way the old
// model did.
function StateDot({ state, isWorking = false }: { state: GenesisState; isWorking?: boolean }) {
  if (state === "idle" && !isWorking) return null;
  const meta = GENESIS_STATE_META[state];
  return (
    <span
      className={`relative inline-flex h-2 w-2 shrink-0 rounded-full ${meta.dotClassName}`}
      aria-hidden="true"
      title={isWorking ? "Genesis is actively working on your last request" : meta.description}
    >
      {isWorking && (
        <span className="absolute -inset-1 rounded-full ring-2 ring-blue-400/70 animate-pulse" aria-hidden="true" />
      )}
    </span>
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
  hasCuriosity: boolean;
}

function GenesisStatusDot({ hasUrgentIssue, hasPendingDecision, hasOpportunity, hasCuriosity }: GenesisSignals) {
  const { pending } = useFormStatus();
  const state = deriveAssessmentState({ hasUrgentIssue, hasPendingDecision, hasOpportunity, hasCuriosity });
  return <StateDot state={state} isWorking={pending} />;
}

// Relays this same real pending value out to lib/dashboard/genesisActivity.ts
// — the only way any GenesisAvatar instance outside this form (the desktop
// rail, the mobile presence bar) can know a request is genuinely in flight,
// since useFormStatus only works for descendants of this specific <form>.
// Renders nothing; exists purely to sync. Same descendant-of-<form>
// requirement as GenesisStatusDot above, which is why it's mounted right
// beside it rather than computed once at a higher level.
function GenesisWorkingPublisher() {
  const { pending } = useFormStatus();
  useEffect(() => {
    setGenesisWorking(pending);
  }, [pending]);
  return null;
}

// Track 0 — AI cost governance's confirm-and-continue affordance. Rendered
// only when the last message in the real chat history is exactly Genesis's
// usage_ceiling failure text (see genesisModelMessages.ts's own comment for
// why that's a shared string constant, not a duplicated literal) — every
// place that ever writes this exact message into StoreMessage/
// StoreDraftMessage is an owner-initiated call (bailOnProviderFailure,
// only ever reached from applyGenesisMessage/applyGenesisMessageToStore),
// so there's no need to separately check a "confirmable" flag here; a
// background/autonomous ceiling block never produces a chat message at all.
//
// Can't be a real nested <form> — the whole panel is already one <form>,
// and HTML forbids nested forms. sendMessage is still the same real Server
// Action, just invoked directly (React 19 supports calling one outside a
// form submission) inside startTransition so this button gets its own
// local pending state, rather than trying to fight useFormStatus (which
// only ever tracks the *parent* form's own native submission).
// Business Assets M2 — "the chat is the place you give Genesis business
// information," not a separate Products/Settings form. Same non-nested-
// form pattern as ConfirmCeilingOverride below (the whole panel is already
// one <form>, so this can't be its own <form>): a hidden file input
// triggered by a styled button, submitted directly via the Server Action
// reference rather than native form submission. `uploadAsset` is optional
// on the parent — the pre-launch draft page (app/dashboard/page.tsx) has
// no real Store yet for a BusinessRecord to attach to, so it doesn't pass
// one, and this row simply doesn't render there.
function UploadAssetButton({
  label,
  icon,
  accept,
  uploadAsset,
  currentPath,
  onFailure,
}: {
  label: string;
  icon: string;
  accept: string;
  uploadAsset: (formData: FormData) => void;
  currentPath: string;
  onFailure: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = "";
          if (!file) return;
          const formData = new FormData();
          formData.set("file", file);
          formData.set("currentPath", currentPath);
          startTransition(async () => {
            const result = await callGenesisAction(() => Promise.resolve(uploadAsset(formData)));
            if (!result.ok) onFailure(result.message);
          });
        }}
      />
      <button
        type="button"
        disabled={isPending}
        onClick={() => inputRef.current?.click()}
        className="rounded-full border border-black/[.08] px-3 py-1.5 text-xs text-zinc-600 transition hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.06] lg:border-[rgba(139,124,246,0.18)] lg:text-[rgba(244,242,251,0.62)] lg:hover:bg-white/[.06]"
      >
        {isPending ? "Uploading…" : `${icon} ${label}`}
      </button>
    </>
  );
}

function ConfirmCeilingOverride({
  sendMessage,
  previousUserMessage,
  currentPath,
  onFailure,
}: {
  sendMessage: (formData: FormData) => void;
  previousUserMessage: string;
  currentPath: string;
  onFailure: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        const formData = new FormData();
        formData.set("message", previousUserMessage);
        formData.set("confirmedOverride", "true");
        formData.set("currentPath", currentPath);
        startTransition(async () => {
          const result = await callGenesisAction(() => Promise.resolve(sendMessage(formData)));
          if (!result.ok) onFailure(result.message);
        });
      }}
      className="self-start rounded-full border border-[var(--brand-accent,var(--foreground))] px-4 py-1.5 text-sm text-[var(--brand-accent,var(--foreground))] transition-opacity hover:opacity-80 disabled:opacity-50 lg:border-[#8b7cf6] lg:text-[#8b7cf6]"
    >
      {isPending ? "Continuing…" : "Continue anyway"}
    </button>
  );
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
  uploadAsset,
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  hasCuriosity,
  focusedContext,
  defaultOpen,
  dockLeft = true,
}: {
  storeName: string;
  messages: Message[];
  sendMessage: (formData: FormData) => void;
  // Business Assets M2 — see UploadAssetButton's own comment for why this
  // is optional. Undefined anywhere the caller has no real Store yet.
  uploadAsset?: (formData: FormData) => void;
  focusedContext?: FocusedContext | null;
  // "Welcome to Genesis" (v20) — the pre-launch draft review page wants
  // chat open by default even with zero messages yet, since talking to
  // Genesis is meant to be the primary way to shape the business, not
  // something a new user has to discover behind a closed pill.
  defaultOpen?: boolean;
  // The lg:+ left-anchor exists to sit beside DashboardShell's left
  // Domicile rail (see GenesisDomicile.tsx). The standalone draft-review
  // page has no such rail — its own form content occupies the left side
  // of the page instead — so left-anchoring there just overlaps the
  // Theme/Store-details controls underneath. Callers without a Domicile
  // rail (the draft page) pass false to keep the bottom-right position.
  dockLeft?: boolean;
} & GenesisSignals) {
  // Mobile chat fix — traced the actual complaint ("chat buries the
  // business after any conversation exists") to the old computation here:
  // reopening purely because messages.length > 0 was designed around
  // desktop, where the panel only ever claims ~25% of a 1440px screen. At
  // phone width the exact same panel is most of the viewport, and it did
  // this on every single page load for any account that had ever talked to
  // Genesis — not a one-time welcome moment, a permanent standing state.
  //
  // Fix: the message-history trigger is now desktop-only (isDesktop, via
  // useSyncExternalStore above — hydration-safe, and reacts live if the
  // window crosses the breakpoint). `open` is a plain derived value most of
  // the time; `userOverride` only exists to remember an explicit close/open
  // click, which must always win over the auto-open condition afterward —
  // this is what keeps "closing chat sticks" (verified behavior) true even
  // though the auto-open condition itself never stops being true.
  // defaultOpen/focusedContext are real, deliberate, one-time reasons to
  // show chat immediately (the "Welcome to Genesis" moment; "Genesis
  // brought you here to review this") and still apply on every viewport —
  // those aren't the pattern that caused the complaint.
  const isDesktop = useSyncExternalStore(subscribeToDesktopWidth, getIsDesktopSnapshot, getIsDesktopServerSnapshot);
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? (defaultOpen || !!focusedContext || (isDesktop && messages.length > 0));
  const setOpen = setUserOverride;
  const pathname = usePathname();

  // Reliability hardening — a real network/timeout failure on the send
  // action never produces a new assistant message (the server-side work
  // never completed), so this is deliberately local, ephemeral UI state,
  // not a StoreMessage row. Cleared on every new attempt.
  const [sendError, setSendError] = useState<string | null>(null);
  async function handleSend(formData: FormData) {
    setSendError(null);
    const result = await callGenesisAction(() => Promise.resolve(sendMessage(formData)));
    if (!result.ok) setSendError(result.message);
  }

  // Track 0 — see ConfirmCeilingOverride's own comment for why a plain
  // string match against the last message is correct here, not a gap.
  const lastMessage = messages[messages.length - 1];
  const showConfirmCeiling = lastMessage?.role === "assistant" && lastMessage.content === USAGE_CEILING_MESSAGE;
  const previousUserMessage = showConfirmCeiling
    ? [...messages].reverse().find((m) => m.role === "user")?.content
    : undefined;

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

  // Mobile safe-area fix — hit-tested and confirmed real: below lg:, this
  // panel is nearly full-width and up to 60vh tall, fixed at the bottom of
  // the viewport. A primary CTA positioned near the bottom of its own page
  // (Confirm & Create Store, Publish Store — both terminal actions, both
  // naturally end-of-page) can end up entirely underneath it. Scrolling to
  // where the button visually is doesn't help, because it's not just
  // covered — clicking there hits the fixed panel instead, silently, with
  // no error. The fix is reserved layout space, not a smaller/repositioned
  // panel: toggling this class adds bottom padding to the *document*
  // itself (see globals.css) exactly when, and only when, the panel is
  // actually open and covering something — every dashboard page below lg:
  // relies on plain document-level scroll (no internal scroll container
  // exists until lg:, per the viewport-containment chain), so one rule on
  // <body> correctly reaches the draft page and every live page uniformly.
  useEffect(() => {
    document.body.classList.toggle("genesis-chat-open", open);
    return () => {
      document.body.classList.remove("genesis-chat-open");
    };
  }, [open]);

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
    // bottom-20 (not bottom-6) below md: — true mobile has its own fixed
    // bottom tab bar (DashboardShell.tsx, md:hidden); confirmed via real
    // bounding-box inspection that bottom-6 put this launcher directly on
    // top of the tab bar's "More" button, covering roughly half its tap
    // target. md:bottom-6 reverts to the original offset the moment that
    // tab bar disappears.
    const closedState = deriveAssessmentState({ hasUrgentIssue, hasPendingDecision, hasOpportunity, hasCuriosity });
    return (
      <button
        onClick={() => setOpen(true)}
        className={
          dockLeft
            ? "fixed bottom-20 right-6 z-50 flex items-center gap-2 rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background shadow-xl transition-transform hover:scale-105 md:bottom-6 lg:right-auto lg:left-6 lg:bg-[#8b7cf6] lg:text-white lg:shadow-[0_0_40px_-10px_rgba(139,124,246,0.35)]"
            : "fixed bottom-20 right-6 z-50 flex items-center gap-2 rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background shadow-xl transition-transform hover:scale-105 md:bottom-6 lg:bg-[#8b7cf6] lg:text-white lg:shadow-[0_0_40px_-10px_rgba(139,124,246,0.35)]"
        }
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
      action={handleSend}
      className={
        dockLeft
          ? "fixed bottom-20 right-6 z-50 flex max-h-[60vh] w-96 max-w-[calc(100vw-3rem)] flex-col rounded-2xl border border-black/[.08] bg-white shadow-xl dark:border-white/[.145] dark:bg-zinc-900 md:bottom-6 lg:right-auto lg:left-6 lg:max-h-none lg:w-80 xl:w-96 lg:border-[rgba(139,124,246,0.18)] lg:bg-[#100d1c] lg:shadow-2xl"
          : "fixed bottom-20 right-6 z-50 flex max-h-[60vh] w-96 max-w-[calc(100vw-3rem)] flex-col rounded-2xl border border-black/[.08] bg-white shadow-xl dark:border-white/[.145] dark:bg-zinc-900 md:bottom-6 lg:max-h-none lg:w-80 xl:w-96 lg:border-[rgba(139,124,246,0.18)] lg:bg-[#100d1c] lg:shadow-2xl"
      }
    >
      <input type="hidden" name="currentPath" value={pathname} />

      <div className="flex shrink-0 items-start justify-between border-b border-black/[.08] p-4 dark:border-white/[.145] lg:border-[rgba(139,124,246,0.18)]">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-[var(--font-heading,inherit)] font-semibold text-black dark:text-zinc-50 lg:text-[#f4f2fb]">
              How can Genesis help today?
            </p>
            <GenesisStatusDot
              hasUrgentIssue={hasUrgentIssue}
              hasPendingDecision={hasPendingDecision}
              hasOpportunity={hasOpportunity}
              hasCuriosity={hasCuriosity}
            />
            <GenesisWorkingPublisher />
          </div>
          <p className="mt-1 text-xs text-zinc-500 lg:text-[rgba(244,242,251,0.62)]">
            Your business partner for {storeName}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          // A real user got stuck unable to close this panel on a phone —
          // whatever else was wrong, a bare "✕" glyph with no padding is a
          // genuinely small, easy-to-miss touch target. -m-2 p-2 expands
          // the actual tappable area to a reasonable ~40px+ without moving
          // the glyph itself or affecting layout.
          className="-m-2 shrink-0 p-2 text-zinc-400 hover:text-black dark:hover:text-zinc-50 lg:text-[rgba(244,242,251,0.62)] lg:hover:text-[#f4f2fb]"
        >
          ✕
        </button>
      </div>

      <div ref={messageListRef} className="flex min-h-0 max-h-48 flex-col gap-3 overflow-y-auto p-4 lg:max-h-80">
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

      {showConfirmCeiling && previousUserMessage && (
        <div className="shrink-0 border-t border-black/[.08] px-4 pt-3 dark:border-white/[.145] lg:border-[rgba(139,124,246,0.18)]">
          <ConfirmCeilingOverride
            sendMessage={sendMessage}
            previousUserMessage={previousUserMessage}
            currentPath={pathname}
            onFailure={setSendError}
          />
        </div>
      )}

      {sendError && (
        <div className="shrink-0 border-t border-black/[.08] px-4 pt-3 text-sm text-red-600 dark:border-white/[.145] dark:text-red-400 lg:border-[rgba(139,124,246,0.18)]">
          {sendError}
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-2 border-t border-black/[.08] p-4 dark:border-white/[.145] lg:border-[rgba(139,124,246,0.18)]">
        {uploadAsset && (
          <div className="flex flex-wrap items-center gap-2">
            <UploadAssetButton
              label="Upload Photos"
              icon="📷"
              accept="image/png,image/jpeg,image/webp"
              uploadAsset={uploadAsset}
              currentPath={pathname}
              onFailure={setSendError}
            />
            <UploadAssetButton
              label="Upload Documents"
              icon="📄"
              accept="application/pdf"
              uploadAsset={uploadAsset}
              currentPath={pathname}
              onFailure={setSendError}
            />
            {/* Honest "coming soon" — zero click target, matching
                ConnectorCard.tsx's own precedent for an unbuilt capability.
                Plugs into the same asset/ingestBusinessAsset pipeline the
                moment video gets its own dedicated milestone. */}
            <span className="cursor-default rounded-full border border-dashed border-black/[.08] px-3 py-1.5 text-xs text-zinc-400 dark:border-white/[.145] dark:text-zinc-500 lg:border-[rgba(244,242,251,0.2)] lg:text-[rgba(244,242,251,0.4)]">
              🎬 Upload Videos — coming soon
            </span>
          </div>
        )}
        <textarea
          name="message"
          placeholder="Ask Genesis anything about your business…"
          rows={2}
          required
          // Real "the owner is actively composing" signal for
          // GenesisAvatar's Listening state (see genesisActivity.ts) — the
          // one new instrumentation this milestone added; stays otherwise
          // uncontrolled (no value/onChange), just relaying focus.
          onFocus={() => setGenesisComposing(true)}
          onBlur={() => setGenesisComposing(false)}
          className="rounded-lg border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50 lg:border-[rgba(139,124,246,0.18)] lg:bg-[#07060d] lg:text-[#f4f2fb] lg:placeholder:text-[rgba(244,242,251,0.62)]"
        />
        <SubmitButton
          pendingText="Genesis is thinking..."
          laterPendingText="Still working on it — detailed answers can take a little longer..."
          className="self-start rounded-full bg-[var(--brand-accent,var(--foreground))] px-4 py-1.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-50 lg:bg-[#8b7cf6]"
        >
          Ask Genesis
        </SubmitButton>
      </div>
    </form>
  );
}
