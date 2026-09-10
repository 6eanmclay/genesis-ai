import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/money";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { resolveOfficeAccess } from "@/lib/j4/officeAccess";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { getOpenTasks } from "@/lib/dashboard/tasks";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";
import { LEGACY_BUSINESS_BASE, businessBasePath, sectionHref } from "@/lib/dashboard/navConfig";
import { sendStoreMessage, uploadBusinessAssetFromChat, uploadPhotoBatchFromChat, uploadVoiceMemo } from "@/app/dashboard/ai-actions";
import { getBusinessUnderstanding, type BusinessUnderstanding } from "@/lib/businessModel/understanding";
import { J4Workspace, type J4Surface as J4SurfaceKind, type UnderstandingGroup } from "./J4Workspace";
import { J4Proposal } from "./J4Proposal";
import { getOpenProposals } from "@/lib/storefront/proposals";
import { getBaseUrl } from "@/lib/integrations/util";
import { messageStateOf } from "@/lib/j4/messageState";
import { listConversations } from "@/lib/j4/conversations";
import type { ContextEntry } from "@/lib/j4/contextTypes";
import { proposalJ4Raised } from "@/lib/intelligence/proactive";
import { officeFacts } from "@/lib/j4/officeFacts";
import { getHandledSince } from "@/lib/dashboard/handled";
import {
  buildBriefing,
  summariseHandled,
  surfaceShowsBriefing,
  type HandledSummary,
} from "@/lib/j4/officeBriefing";
import {
  officeActionForObservation,
  officeActionForExplanation,
  type OfficeAction,
} from "@/lib/j4/officeActions";

// J4's real conversation, rendered on either of its two surfaces
// (2026-08-14). Extracted from app/j4/page.tsx unchanged so that both the
// persistent layer over the business workspace and the full /j4 room are
// literally the same code reading the same rows — one conversation, one set
// of server actions, one Request → Execute → Verify → Record → Display path.
//
// Sean's clarification, which is what the `surface` prop encodes:
//
//   "The persistent J4 summon is not a shortcut to the J4 page. It is the
//   primary way users converse with J4 while working inside their business."
//
//   "The full J4 page is a deliberate deep work and review destination."
//
// So the layer is conversation, and the room is conversation plus the
// record: Tasks, Ideas, Decisions, Information. The split is honoured here
// too, not only in the markup — the layer does not read what it will not
// show. That matters because the layer is rendered by app/dashboard/
// layout.tsx on every dashboard page, so anything fetched here is fetched on
// every navigation the owner makes.
// The store's own currency, threaded rather than assumed. These lines are read
// back to the owner as what J4 understands about their business, so a figure
// carrying the wrong symbol is a claim about which money the business takes.
/**
 * How far back "already handled" looks.
 *
 * A fortnight: long enough that an owner who was away for a week still sees
 * what happened, short enough that the list is what J4 has been doing lately
 * rather than a history. The number travels with the figures to the screen -
 * see HandledSummary.windowDays - so a count is never shown without its window.
 */
const HANDLED_WINDOW_DAYS = 14;

const formatCents = formatMoney;



// What J4 understands, flattened into headings and plain lines for the Office
// (2026-08-16).
//
// This is the same material as /dashboard/understanding and reads from the
// same getBusinessUnderstanding() call, deliberately: there is one answer to
// "what does J4 know," and a second assembly of the same facts would be free
// to drift from it. The page keeps the full version with its links out to
// brand, catalog, customers and connections; this is that picture read as a
// briefing, inside the Office where the rest of J4's material already lives.
//
// Every group is returned even when it is empty, and each carries its own
// sentence for that case. "I don't know your suppliers yet" is real
// information about the state of J4's understanding — dropping empty groups
// would quietly overstate how much it knows.

// A REAL CROSS-BUSINESS LEAK, found by the browser session (2026-08-20).
//
// This surface is rendered by the workspace shell, so it appears on every screen
// — including every screen under /b/[slug]. It resolved the account's ACTIVE
// business rather than the one being viewed, so J4's tasks, ideas, decisions and
// information for one business were rendered on another business's pages.
//
// Nothing in the database was wrong and no authorization was bypassed; the rows
// were correctly scoped to the business they belonged to. This read the wrong
// business, which is the same class of defect and just as visible to an owner:
// they open Copper & Coil and J4 talks to them about Iron Gym.
//
// Not caught by any suite, because every suite asserts on resolution and
// authorization. It took a real browser rendering a real page to see it — which
// is the argument for the browser session, made by the browser session.
export async function J4Surface({ surface, slug }: { surface: J4SurfaceKind; slug?: string }) {
  // `isRoom` used to live here and gated the Tasks read. Both surfaces now
  // fetch the same material, because both surfaces show it — see the Promise
  // .all below. Deleted rather than left unused: a ready-made "the layer is
  // the lesser surface" flag is what the last two bugs were built on.

  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  // The business this surface was rendered inside, when there is one. Falls back
  // to the account's active business only on the legacy route, which has no slug
  // to be told about.
  // THE SAME RESOLVER THE ACTIONS USE (2026-09-09). It was this expression,
  // and the two server actions the tier split created each wrote their own
  // version of it - both with the arguments the wrong way round, which no
  // compiler could catch because they are both strings. One resolver means the
  // order can only be wrong in one place. See lib/j4/officeAccess.ts.
  const resolved = await resolveOfficeAccess(session.user.id, slug);
  if (!resolved) {
    // No real store yet — J4 has nothing to work on. Back to onboarding.
    redirect("/onboarding");
  }
  const { store, role } = resolved;
  if (!hasPermission(role, PERMISSIONS.GENESIS_CHAT)) {
    redirect("/dashboard");
  }

  // Same bounded window app/api/chat/route.ts already uses for the same
  // real reason (a store's entire lifetime history was previously fed
  // into every AI call uncapped) — kept in sync deliberately, not by
  // coincidence.
  const CHAT_HISTORY_WINDOW = 50;
  // THE CRITICAL PATH IS THE CONVERSATION, AND NOTHING ELSE (2026-09-09).
  //
  // This Promise.all used to hold seven reads and the shell waited for the
  // slowest. Measured against production: understanding 921ms, handled 499ms,
  // approvals 185ms, conversation 167ms, explanations 74ms, observations 72ms,
  // tasks 66ms. None of the other six is needed to render J4, the shell, or a
  // composer the owner can type into.
  //
  // Sean: "I don't want J4 waiting for every business-data query before he can
  // acknowledge me." So the six moved - the understanding to on-demand
  // (understanding-actions.ts), the rest to progressive
  // (intelligence-actions.ts) - and the conversation, which the surface
  // genuinely renders, stayed.
  //
  // Nothing was deleted. Every read still runs, with the same rules and the
  // same permission tiers; they run after the owner can already talk to him.
  // FOUR SEQUENTIAL AWAITS BECAME ONE (2026-09-09).
  //
  // Reducing the Promise.all to the conversation exposed something the seven
  // slow reads had been hiding: the proposals, the raised-proposal lookup and
  // the conversation list were each awaited on their own line, one after the
  // other. Concurrently the floor is the slowest of them; sequentially it is
  // the SUM, and that sum was in front of the composer.
  //
  // They are independent of each other and of the messages, so they run
  // together. proposalOnTable still needs raisedId, but that is arithmetic on
  // results rather than another round trip.
  const [recentMessages, openProposals, raisedId, conversations] = await Promise.all([
    prisma.storeMessage.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: CHAT_HISTORY_WINDOW,
    // WHAT ACTUALLY HAPPENED, alongside what was said about it (UI6). Joined
    // rather than fetched separately: the conversation renders both together,
    // and a second query would be a second answer to "did that work" one
    // round trip later.
      include: {
        executionLog: { select: { status: true, retryable: true, metadata: true } },
      },
    }),
    getOpenProposals(store.id),
    proposalJ4Raised(store.id),
    listConversations(store.id),
  ]);

  // THE proposal on the table — one, never a stack (2026-08-14).
  //
  // Sean: "there must only be ONE J4 conversation." Several proposal cards
  // above one composer read as several parallel threads, which is exactly the
  // fragmentation being ruled out. So this shows the one currently under
  // discussion (newest first) and says plainly that others are waiting rather
  // than rendering them as competing conversations.
  //
  // BOTH SURFACES, corrected 2026-08-14. This was layer-only for one build,
  // on the reasoning that the layer is where proposals belong. That was wrong,
  // and Sean caught it from a screenshot: the room shows the SAME conversation,
  // so a proposal raised while the owner is reading it there simply never
  // appeared, and the decision was unreachable from the very place the
  // discussion was happening. A proposal belongs to the CONVERSATION, and the
  // conversation is on both surfaces. See GENESIS_SURFACES.md decision 4.

  // THE ONE J4 ACTUALLY RAISED, when it raised one (PD4, 2026-08-23).
  //
  // This took openProposals[0] — the newest pending proposal, related to the
  // conversation or not. Once J4 can speak first, that is a real mismatch: a
  // proactive message about falling revenue sitting directly above a card
  // proposing a new hero image reads as one thing, and is not.
  //
  // So when J4 has spoken about a finding that produced a decision, the card is
  // that decision. Otherwise nothing changes — this narrows which proposal is
  // shown, it does not add a second place proposals live, and J4 still never
  // decides one.

  const proposalOnTable =
    (raisedId ? openProposals.find((p) => p.current.id === raisedId) : null) ??
    openProposals[0] ??
    null;
  const otherPendingCount = Math.max(0, openProposals.length - 1);
  const storefrontUrl = proposalOnTable ? `${await getBaseUrl()}/store/${store.slug}` : null;

  // THE OWNER'S CONVERSATIONS (UI6 piece 2). Read here rather than in the
  // client so the layer stays a client component that is handed its data, the
  // same arrangement the proposal card already uses.


  // WHAT THE CONTEXT PANE MAY SHOW (UI6 piece 1). Built here from the
  // understanding this render already fetched — so the pane costs no query of
  // its own, and shows what J4 knows NOW rather than a reconstruction of what it
  // knew when a conversation started.
  //
  // The closed registry decides what is eligible. Nothing outside it can reach
  // the pane, because nothing else is read.
  // EMPTY UNTIL ASKED FOR, and the pane knows the difference. The entries are
  // built from the same 921ms understanding read; loading them here would put
  // the context pane's cost in front of every owner who never opens it. The
  // client loads them with the Understanding groups, and shows "loading"
  // rather than the pane's honest "Nothing recorded yet" - which would be a
  // false statement about the business, not a slow one.
  const contextEntries: ContextEntry[] = [];

  const messages = recentMessages.reverse();

  // THE SIGNALS MOVED WITH THE DATA THEY ARE MADE OF (2026-09-09).
  //
  // hasUrgentIssue / hasOpportunity / hasCuriosity / hasPendingDecision were
  // derived here from the observation, explanation and approval reads. Those
  // reads are progressive now, so deriving the signals here would have pulled
  // all three back onto the critical path to colour one status dot.
  //
  // J4 is present immediately; what he is concerned ABOUT arrives with the
  // rest of the intelligence, a moment later. That is the honest version of
  // the tier - the alternative is a dot that is accurate at the cost of the
  // composer, which is the trade Sean ruled out.
  const hasUrgentIssue = false;
  const hasOpportunity = false;
  const hasCuriosity = false;
  const hasPendingDecision = false;

  return (
    <J4Workspace
      surface={surface}
      slug={slug}
      storeName={store.name}
      contextEntries={contextEntries}
      conversations={conversations.map((c) => ({
        id: c.id,
        name: c.name,
        messageCount: c.messageCount,
        lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
        // The anchored work's title, when there is one. Metadata the pane names
        // — never a link, and never something to act on.
        // NULL RATHER THAN A TASKS READ (2026-09-09). This was the only use of
        // the open-tasks list outside the Tasks view, and it decorates a
        // conversation label in a picker most owners never open. Keeping it
        // would have put a 66ms read back on the critical path to title a row
        // that is already identified by its conversation name.
        //
        // The pane treats null as "no anchored work", which is what it showed
        // for every conversation without a task anyway — so this is a missing
        // decoration, not a wrong statement.
        anchoredWork: null,
      }))}
      messages={messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        changes: m.changes,
        // Which conversation this belongs to, or null for everything written
        // before conversations existed. Never manufactured.
        conversationId: m.conversationId,
        // Derived on the server from the execution row, never from the words.
        // A message with no row is "spoken" — see messageStateOf on why that
        // must not read as success.
        state: messageStateOf(
          m.executionLog
            ? {
                status: m.executionLog.status,
                retryable: m.executionLog.retryable,
                kind:
                  typeof m.executionLog.metadata === "object" &&
                  m.executionLog.metadata !== null &&
                  "kind" in m.executionLog.metadata
                    ? String((m.executionLog.metadata as { kind: unknown }).kind)
                    : null,
              }
            : null
        ),
      }))}
      sendMessage={sendStoreMessage}
      uploadAsset={uploadBusinessAssetFromChat}
      uploadPhotoBatch={uploadPhotoBatchFromChat}
      uploadVoiceMemo={uploadVoiceMemo}
      hasUrgentIssue={hasUrgentIssue}
      hasPendingDecision={hasPendingDecision}
      hasOpportunity={hasOpportunity}
      hasCuriosity={hasCuriosity}
      // THE PROGRESSIVE TIER IS NOT PASSED FROM HERE ANY MORE (2026-09-09).
      //
      // tasks, decisions, ideas, information, the briefing, the facts strip and
      // the handled summary all used to be resolved above, inside the awaited
      // Promise.all that renders this surface - so the composer could not be
      // typed into until the slowest of them returned. Measured against
      // production that was 499ms of handled/changed on top of 185ms of
      // approvals, none of it needed to say hello to J4.
      //
      // J4Workspace now loads them itself, once mounted, through
      // app/j4/intelligence-actions.ts. Same reads, same rules, same rows -
      // after the shell rather than in front of it. Sean: "If the briefing
      // takes another second to arrive, I should still be able to talk to J4
      // immediately."
      //
      // The props still exist and still win when passed, so nothing that hands
      // them down directly changed behaviour.
      // Rendered on the server and handed down, so the layer stays a client
      // component without needing to fetch or know about proposals itself.
      proposal={
        proposalOnTable && storefrontUrl ? (
          <J4Proposal
            proposal={proposalOnTable}
            storefrontUrl={storefrontUrl}
            storeName={store.name}
            // The business this conversation is, handed to the decisions inside
            // it — see J4Proposal's own note on why the action is told rather
            // than asking.
            slug={slug}
            otherPendingCount={otherPendingCount}
          />
        ) : null
      }
    />
  );
}
