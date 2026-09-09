"use client";

import Link from "next/link";
import type { BriefingItem, HandledSummary } from "@/lib/j4/officeBriefing";

/**
 * WHAT J4 SAYS BEFORE HE IS ASKED.
 *
 * ============ THE ARRIVAL SURFACE, NOT ANOTHER TAB (2026-09-09) ========
 *
 * Sean: "Right now you are physically present in the Office and the
 * intelligence is real/actionable, but the important things you've discovered
 * are still hidden behind tabs... Do not simply add another tab or another
 * dashboard card. The intelligence should come forward and become the primary
 * Office experience."
 *
 * Measured on Cubit & Coil before this: the Office opened on
 * `activeCategory = "conversation"` with **40 items J4 already knew, loaded on
 * every visit, and none of them on screen**.
 *
 * This is now the default view. The tabs remain, because a queue is still a
 * useful way to work one kind down - but the owner no longer has to pick one
 * to find out whether anything is wrong.
 *
 * ============ EVERY ROW ANSWERS THE SAME FOUR THINGS ===================
 *
 * What J4 found, why it matters, what you can do, and - for a decision - what
 * he will do if you say yes. There is no fifth ornament. A row with nothing to
 * act on says so in the same place the button would have been, which is the
 * action-layer rule (officeActions.ts) applied to a bigger surface rather than
 * a second version of it.
 *
 * Nothing here computes anything. Order, wording of the standing time, and the
 * decision about what counts as news all come from lib/j4/officeBriefing.ts,
 * where they are testable without a browser.
 */
export function OfficeBriefing({
  items,
  handled,
  onApprove,
  approvingId,
  onOpenConversation,
}: {
  items: BriefingItem[];
  handled: HandledSummary;
  /** Runs approveGenesisAction — the same server action the conversation uses. */
  onApprove: (id: string) => void;
  /** The decision currently being executed, so the button can say so. */
  approvingId: string | null;
  onOpenConversation: () => void;
}) {
  const nothingFound = items.length === 0;

  return (
    <div data-testid="office-briefing" className="flex flex-col gap-5 px-4 py-5 sm:px-6">
      <div>
        <h2 className="text-[13px] font-semibold uppercase tracking-[.14em] text-[#4ade3a]">
          {nothingFound ? "Nothing needs you" : "What needs you"}
        </h2>
        <p className="mt-1 text-[13px] text-white/50">
          {nothingFound
            ? "I have not found anything waiting on you. I will say so here when I do."
            : "In the order I would work through them."}
        </p>
      </div>

      {items.length > 0 && (
        <ol data-testid="briefing-items" className="flex flex-col gap-2.5">
          {items.map((item) => (
            <li key={item.id}>
              <BriefingRow item={item} onApprove={onApprove} approving={approvingId === item.id} />
            </li>
          ))}
        </ol>
      )}

      <Handled handled={handled} />

      {/* He is a partner, so the briefing ends by offering to talk about it
          rather than at the bottom of a list. */}
      <button
        type="button"
        onClick={onOpenConversation}
        data-testid="briefing-talk"
        className="self-start rounded-full border border-[#4ade3a]/30 px-4 py-2 text-[13px] font-medium text-[#4ade3a] transition hover:border-[#4ade3a]/60 hover:bg-[#4ade3a]/[.06]"
      >
        Talk to me about any of this
      </button>
    </div>
  );
}

const KIND_DOT: Record<BriefingItem["kind"], string> = {
  decision: "bg-amber-400",
  problem_actionable: "bg-red-500",
  problem_inert: "bg-red-500/40",
  opportunity_actionable: "bg-[#4ade3a]",
  opportunity_inert: "bg-[#4ade3a]/40",
};

const KIND_LABEL: Record<BriefingItem["kind"], string> = {
  decision: "Waiting on you",
  problem_actionable: "Needs fixing",
  problem_inert: "Something is off",
  opportunity_actionable: "Worth doing",
  opportunity_inert: "Noticed",
};

function BriefingRow({
  item,
  onApprove,
  approving,
}: {
  item: BriefingItem;
  onApprove: (id: string) => void;
  approving: boolean;
}) {
  return (
    <div
      data-testid={`briefing-row-${item.kind}`}
      data-kind={item.kind}
      className="rounded-xl border border-white/[.07] bg-white/[.02] p-3.5"
    >
      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[item.kind]}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-[.12em] text-white/35">
            {KIND_LABEL[item.kind]}
          </p>
          <p className="mt-1 break-words text-[14.5px] leading-snug text-[#f4f2fb]">{item.headline}</p>

          {/* WHY, ONLY WHEN THERE IS A WHY. Null renders nothing at all —
              never a stand-in sentence, which is the rule the module enforces
              and this honours rather than re-decides. */}
          {item.why && (
            <p data-testid="briefing-why" className="mt-1 text-[12.5px] italic leading-snug text-white/45">
              {item.why}
            </p>
          )}

          <div className="mt-2.5">
            {item.action.kind === "open" && (
              <Link
                href={item.action.href}
                data-testid="briefing-action-open"
                className="inline-flex items-center gap-1.5 rounded-full bg-[#4ade3a]/[.12] px-3.5 py-1.5 text-[12.5px] font-medium text-[#4ade3a] transition hover:bg-[#4ade3a]/20"
              >
                {item.action.label}
                <span aria-hidden="true">&rarr;</span>
              </Link>
            )}

            {item.action.kind === "execute" && (
              <button
                type="button"
                data-testid="briefing-action-execute"
                disabled={approving}
                onClick={() => onApprove(item.id)}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#4ade3a] px-3.5 py-1.5 text-[12.5px] font-semibold text-[#06210a] transition hover:brightness-110 disabled:opacity-60"
              >
                {approving ? "Doing it…" : item.action.label}
              </button>
            )}

            {/* THE INERT CASE OCCUPIES THE SPACE THE BUTTON WOULD HAVE. It is
                not hidden and it is not styled to look pressable — the owner
                is told, in the place they would look for the control, that
                there is nothing to press and why. */}
            {(item.action.kind === "none" || item.action.kind === "internal") && (
              <p data-testid="briefing-action-none" className="text-[12.5px] leading-snug text-white/35">
                {item.action.because}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * What J4 got on with, and what actually changed.
 *
 * The counts are filtered by the same rule the attention rows use, so this
 * cannot become a log file: 238 successful executions on Cubit & Coil in a
 * fortnight, of which about twenty are things an owner would call a change.
 */
function Handled({ handled }: { handled: HandledSummary }) {
  const nothing = handled.resolvedByJ4 === 0 && handled.changes.length === 0 && handled.decisionsSettled === 0;
  if (nothing) return null;

  return (
    <section data-testid="briefing-handled" className="rounded-xl border border-white/[.06] bg-white/[.015] p-3.5">
      <h3 className="text-[10px] font-medium uppercase tracking-[.12em] text-white/35">
        Already handled &middot; last {handled.windowDays} days
      </h3>
      <ul className="mt-2 flex flex-col gap-1 text-[13px] text-white/55">
        {handled.resolvedByJ4 > 0 && (
          <li data-testid="handled-resolved">
            <strong className="font-mono tabular-nums text-[#4ade3a]">{handled.resolvedByJ4}</strong>{" "}
            {handled.resolvedByJ4 === 1 ? "thing I was watching cleared" : "things I was watching cleared"} on their own
          </li>
        )}
        {handled.decisionsSettled > 0 && (
          <li data-testid="handled-decisions">
            <strong className="font-mono tabular-nums text-[#4ade3a]">{handled.decisionsSettled}</strong>{" "}
            {handled.decisionsSettled === 1 ? "decision" : "decisions"} you settled
          </li>
        )}
        {handled.changes.map((c) => (
          <li key={c.action} data-testid="handled-change">
            <strong className="font-mono tabular-nums text-[#4ade3a]">{c.n}</strong>{" "}
            {describeChange(c.action, c.n)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A real act, named the way an owner would name it.
 *
 * Falls back to the raw action id ONLY as a last resort, and that is
 * deliberate: an unnamed action showing up here is a gap in this map, and
 * seeing `product.reorder_images` on screen is how it gets noticed. Inventing
 * a friendly phrase for an action nobody described would hide it instead —
 * this repository already records a cuid becoming a SKU that way.
 */
function describeChange(action: string, n: number): string {
  const one = n === 1;
  switch (action) {
    case "product.create":
      return one ? "product added" : "products added";
    case "product.edit":
      return one ? "product updated" : "products updated";
    case "product.delete":
      return one ? "product removed" : "products removed";
    case "product.update_image":
    case "product.add_images":
      return one ? "product photo updated" : "product photos updated";
    case "order.toggle_fulfilled":
      return one ? "order marked fulfilled" : "orders marked fulfilled";
    case "order.attach_tracking":
    case "order.correct_tracking":
      return one ? "tracking number added" : "tracking numbers added";
    case "order.purchase_shipping_label":
      return one ? "shipping label bought" : "shipping labels bought";
    case "promotion.create":
      return one ? "promotion created" : "promotions created";
    case "promotion.update":
      return one ? "promotion updated" : "promotions updated";
    case "store.publish":
      return one ? "storefront published" : "storefront publishes";
    case "integration.paypal.verify":
    case "integration.stripe.verify":
    case "integration.google_calendar.verify":
    case "integration.quickbooks.verify":
    case "integration.mailchimp.verify":
      return one ? "connection checked" : "connections checked";
    default:
      return action;
  }
}
