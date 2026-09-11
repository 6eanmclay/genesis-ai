"use client";

import Link from "next/link";
import type { HandledSummary } from "@/lib/j4/officeBriefing";
// FROM officeSections, NOT officeWork. The derivation module value-imports
// ASSET_ROLES, which reaches prisma; importing `itemsIn` from there put the
// database client in the browser bundle and this panel silently never painted.
import { itemsIn, type OfficeSection, type OfficeWork, type WorkItem } from "@/lib/j4/officeSections";

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
/**
 * ============ THE FIVE STATES REPLACE J4'S FILING SYSTEM (2026-09-11) ==
 *
 * Sean: "The Office should be organized by what J4 can DO about something, not
 * by J4's internal taxonomy of Tasks / Ideas / Decisions / Information."
 *
 * What stood here was BRIEFING_ORDER's five kinds - decision,
 * problem_actionable, problem_inert, opportunity_actionable,
 * opportunity_inert. Those describe what a row IS. An owner arriving does not
 * think "is this an inert opportunity"; they think "is this mine to do".
 *
 * Each section below is a FILTER over one list, keyed by the item's own
 * action. There is no second query, no per-section data source, and no way for
 * a section to disagree with the control on its own row - sectionFor() is the
 * only thing that decides placement, and it reads the action.
 */
const SECTIONS: { key: OfficeSection; title: string; blurb: string; empty: string; accent: string }[] = [
  {
    key: "needs_you",
    title: "Needs you",
    // FIRST, because it is the bottleneck J4 cannot multiply.
    blurb: "I know what has to happen. This part has to come from you.",
    empty: "Nothing is waiting on you right now.",
    accent: "text-amber-300",
  },
  {
    key: "ready_to_go",
    title: "Ready to go",
    blurb: "I can do these now, with what I actually have.",
    empty: "Nothing I can act on by myself at the moment.",
    accent: "text-[#4ade3a]",
  },
  {
    key: "decide",
    title: "Decide",
    blurb: "Your call. Nothing happens until you say so.",
    empty: "No decisions waiting.",
    accent: "text-amber-300",
  },
  {
    key: "noticed",
    title: "Noticed",
    // THE HONEST SECTION. Sean: "Keep these visible and honest. Do not invent
    // a lever merely to make something actionable."
    blurb: "I have seen these and cannot act on them yet.",
    empty: "Nothing else on my mind.",
    accent: "text-white/40",
  },
];

export function OfficeBriefing({
  work,
  handled,
  onApprove,
  approvingId,
  onOpenConversation,
  loading = false,
}: {
  /** The one list. Null while the progressive tier is still loading. */
  work: OfficeWork | null;
  handled: HandledSummary;
  /** Runs approveGenesisAction — the same server action the conversation uses. */
  onApprove: (id: string) => void;
  /** The decision currently being executed, so the button can say so. */
  approvingId: string | null;
  onOpenConversation: () => void;
  loading?: boolean;
}) {
  // A SURFACE THAT HAS NOT LOADED AND A BUSINESS WITH NOTHING WAITING ARE
  // DIFFERENT FACTS. Saying "nothing needs you" before looking is the same
  // class of lie as claiming a change succeeded because it was stored.
  if (loading || !work) {
    return (
      <div data-testid="office-briefing" data-office-state="loading" className="flex flex-col gap-5 px-4 py-5 sm:px-6">
        <p data-testid="office-loading" className="text-[13px] text-white/40">
          Looking at where things stand&hellip;
        </p>
      </div>
    );
  }

  const nothingAtAll = work.items.length === 0;

  return (
    <div data-testid="office-briefing" data-office-state="ready" className="flex flex-col gap-6 px-4 py-5 sm:px-6">
      {SECTIONS.map((section) => {
        const items = itemsIn(work, section.key);
        return (
          <section key={section.key} data-testid={`office-section-${section.key}`} data-count={items.length}>
            <h2 className={`text-[13px] font-semibold uppercase tracking-[.14em] ${section.accent}`}>
              {section.title}
            </h2>
            <p className="mt-1 text-[13px] text-white/50">{items.length > 0 ? section.blurb : section.empty}</p>

            {items.length > 0 && (
              <ol className="mt-3 flex flex-col gap-2.5">
                {items.map((item) => (
                  <li key={item.id}>
                    <WorkRow item={item} onApprove={onApprove} approving={approvingId === item.id} />
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}

      <Handled handled={handled} />

      {nothingAtAll && (
        <p data-testid="office-nothing" className="text-[13px] text-white/40">
          I have not found anything waiting on you. I will say so here when I do.
        </p>
      )}

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

/** What kind of missing thing, said in the owner's words rather than the type's. */
const MISSING_LABEL = {
  information: "I need to know something",
  decision: "Yours to decide",
  permission: "I need your permission",
  capability: "I cannot do this one",
} as const;

function WorkRow({
  item,
  onApprove,
  approving,
}: {
  item: WorkItem;
  onApprove: (id: string) => void;
  approving: boolean;
}) {
  const { action } = item;
  return (
    <div
      data-testid="work-row"
      data-action={action.kind}
      // The work id, so a suite can prove that what the strip counts is what
      // the page renders. A task carries a `task:` prefix, which is how
      // "counted but missing" became a testable claim after three real open
      // tasks were counted in the strip and rendered in no section at all.
      data-work-id={item.id}
      className="rounded-xl border border-white/[.07] bg-white/[.02] p-3.5"
    >
      <p className="break-words text-[14.5px] leading-snug text-[#f4f2fb]">{item.headline}</p>

      {/* WHY, ONLY WHEN THERE IS A WHY. Null renders nothing at all — never a
          stand-in sentence, which is the rule officeBriefing.ts enforces and
          this honours rather than re-decides. */}
      {item.why && (
        <p data-testid="work-why" className="mt-1 text-[12.5px] italic leading-snug text-white/45">
          {item.why}
        </p>
      )}

      <div className="mt-2.5">
        {/* ============ NEEDS YOU ====================================
            Sean: "NEEDS YOU must explicitly state what J4 needs from the
            owner and why." Both, separately, and neither optional — the
            type makes a row that cannot say them unrepresentable. */}
        {action.kind === "needs_owner" && (
          <div data-testid="work-needs-owner" data-missing={action.missing}>
            <p className="text-[10px] font-medium uppercase tracking-[.12em] text-amber-300/70">
              {MISSING_LABEL[action.missing]}
            </p>
            <p data-testid="needs-what" className="mt-1 text-[13px] leading-snug text-[#f4f2fb]">
              What I need: {action.what}
            </p>
            <p data-testid="needs-because" className="mt-1 text-[12.5px] leading-snug text-white/45">
              {action.because}
            </p>
            {/* ONLY WHEN A REAL DESTINATION EXISTS. Sean: "Do not turn
                needs_owner into another button just for the sake of having
                an action." Absent means no control at all, not a dim one. */}
            {action.provideAt && (
              <Link
                href={action.provideAt.href}
                data-testid="needs-provide"
                className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-300/[.12] px-3.5 py-1.5 text-[12.5px] font-medium text-amber-200 transition hover:bg-amber-300/20"
              >
                {action.provideAt.label}
                <span aria-hidden="true">&rarr;</span>
              </Link>
            )}
          </div>
        )}

        {/* ============ READY TO GO / DECIDE =========================
            Same control, two different promises. `act` is work to release;
            `decide` is a choice, and its row says plainly that nothing has
            happened yet. */}
        {action.kind === "execute" && (
          <div data-testid={action.offer === "decide" ? "work-decide" : "work-ready"}>
            <button
              type="button"
              data-testid="work-action-execute"
              data-offer={action.offer}
              disabled={approving}
              onClick={() => onApprove(item.id)}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#4ade3a] px-3.5 py-1.5 text-[12.5px] font-semibold text-[#06210a] transition hover:brightness-110 disabled:opacity-60"
            >
              {approving ? "Doing it…" : action.label}
            </button>
            {action.offer === "decide" && (
              <p data-testid="decide-nothing-yet" className="mt-1.5 text-[12px] text-white/35">
                Nothing changes until you approve this.
              </p>
            )}
          </div>
        )}

        {action.kind === "open" && (
          <Link
            href={action.href}
            data-testid="work-action-open"
            className="inline-flex items-center gap-1.5 rounded-full bg-[#4ade3a]/[.12] px-3.5 py-1.5 text-[12.5px] font-medium text-[#4ade3a] transition hover:bg-[#4ade3a]/20"
          >
            {action.label}
            <span aria-hidden="true">&rarr;</span>
          </Link>
        )}

        {/* THE INERT CASE OCCUPIES THE SPACE THE BUTTON WOULD HAVE. Not
            hidden, and not styled to look pressable — the owner is told, in
            the place they would look for a control, that there is nothing to
            press and why. */}
        {action.kind === "none" && (
          <p data-testid="work-action-none" className="text-[12.5px] leading-snug text-white/35">
            {action.because}
          </p>
        )}
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
      {/* ============ DONE, AND WHAT IT CANNOT YET SAY ==================
          Sean: "DONE must distinguish what was requested, what was executed,
          what was observed, and whether success was actually verified."

          HandledSummary carries none of those four. It counts executions that
          really happened, which is true but is not the same claim. The four-way
          distinction exists today only in ExecutionReport, on the Reference
          Design path, where `succeeded` is derived from a real rendered check.

          So this renders what it actually knows and no more. Labelling these
          counts "verified" would be manufacturing a verification claim from
          storage state, which is the exact thing that path exists to prevent. */}
      <h3 className="text-[10px] font-medium uppercase tracking-[.12em] text-white/35">
        Done &middot; last {handled.windowDays} days
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
