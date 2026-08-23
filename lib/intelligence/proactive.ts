import { prisma } from "@/lib/prisma";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";

// J4 SPEAKS FIRST (2026-08-23).
//
// VISION.md Chapter 1's shift, from "What would you like to do today?" to
// "Here's what I noticed." The audit that preceded this found the engine was
// already built — the cycle, the detectors, the findings lifecycle, beliefs,
// the confidence signal — and that the missing piece was one sentence long:
// nothing in this codebase ever wrote an unprompted assistant message. Every
// `role: "assistant"` write sat inside a turn the owner started.
//
// So J4's proactivity was cards, and cards are software. This is the same
// findings, said.
//
// WHAT THIS DELIBERATELY IS NOT:
//
// - Not a second intelligence system. GenesisObservation stays the only source
//   of truth for what is true about a business. Nothing here computes a
//   finding, ranks one on its own axis, or stores a copy of one.
// - Not model-generated. The sentence is assembled from the finding's own
//   summary — the text the detector already wrote for the owner to read. A
//   proactive J4 that needed an API key to say anything would be a proactive J4
//   that stops working when a credential expires, and the whole point is that
//   this runs unattended.
// - Not a proposal. This speaks; it does not act. A finding that already has a
//   proposal attached is pointed at, never approved on the owner's behalf.
//
// GROUNDING, AND A CORRECTION TO THE CONTRACT. PROACTIVE_J4_CONTRACT.md's PD2
// recommended grounding on getNextBestAction's single highest-confidence item.
// Reading it settled the question the other way: that function takes a userId,
// can trigger a cognitive review, and is about pending PROPOSALS rather than
// findings — grounding on it would have made proactivity depend on a model,
// which is the one thing this must not do. The intent behind PD2 (one item, the
// most important) is honoured on the substrate that actually holds findings.

/** How a finding is chosen when more than one is standing. */
const STATE_PRIORITY: Record<string, number> = {
  // Something is wrong. It outranks an opportunity every time — an owner
  // interrupted about an opportunity while a problem stands would rightly
  // wonder what J4 is paying attention to.
  urgent: 0,
  opportunity: 1,
};

/**
 * How many findings J4 may raise in one cycle.
 *
 * ONE, and this is inferred rather than chosen (PD3). The contract recorded no
 * recommendation for a rate limit because a number picked from nothing is a
 * product judgement in disguise. It does not need one: PD2 already says a
 * single item, and a delivery is closed only when its finding stops being true,
 * so the real ceiling is "one new thing, once" — a business where nothing
 * changes hears nothing at all, however often the cycle runs.
 */
const FINDINGS_PER_CYCLE = 1;

/**
 * The sentence, built from the finding.
 *
 * PLAIN AND SHORT, and it says where it came from without naming a mechanism.
 * The summary is the detector's own owner-facing line — the same words the card
 * shows — so the conversation and the dashboard cannot describe one finding two
 * different ways.
 */
export function proactiveMessageFor(finding: { genesisState: string; summary: string }): string {
  // A FINDING THAT IS ALREADY A QUESTION INTRODUCES ITSELF (2026-08-23). Some
  // findings are asks — "…would you like to upload your employee handbook so I
  // can understand your policies?" — and prefixing "I noticed something worth a
  // look" in front of one adds a beat that says nothing before a sentence that
  // already carries its own reason. Filler is how copy stops sounding like a
  // person.
  //
  // Detected from the sentence rather than from a flag on the finding: a flag
  // would be a second thing to keep true, and whether a summary is a question is
  // already visible in the summary.
  if (finding.summary.trim().endsWith("?")) return finding.summary;

  const opening =
    finding.genesisState === "urgent"
      ? "Something needs your attention."
      : "I noticed something worth a look.";
  // No trailing invitation to "let me know" — the composer is directly beneath
  // this and the owner can simply reply. A prompt to reply, on a message that
  // is already in their conversation, reads as software.
  return `${opening} ${finding.summary}`;
}

export interface ProactiveDeliverySummary {
  /** How many findings J4 spoke about. Zero is an ordinary, correct outcome. */
  spoken: number;
  /** Deliveries retired because their finding stopped being active. */
  closed: number;
}

/**
 * Say what is worth saying, once, in the business it belongs to.
 *
 * Called from the intelligence cycle, which already runs per business and has
 * no session and no active-business pointer — which makes this SAFER than the
 * request path rather than more dangerous, but only because the storeId comes
 * from the cycle and is used for every read and write below. That is the exact
 * defect class found four times in the days before this was written.
 */
export async function speakNewFindings(storeId: string): Promise<ProactiveDeliverySummary> {
  // FIRST, RELEASE ANYTHING THAT STOPPED BEING TRUE. A delivery is closed when
  // its finding is no longer ACTIVE, which is what allows J4 to mention it
  // again if it ever comes back. Closing never touches the message: what J4
  // said stays said, and a finding disappearing does not un-say it.
  const closable = await prisma.proactiveDelivery.findMany({
    where: {
      storeId,
      closedAt: null,
      observation: { status: { not: "ACTIVE" } },
    },
    select: { id: true },
  });
  if (closable.length > 0) {
    await prisma.proactiveDelivery.updateMany({
      where: { storeId, id: { in: closable.map((d) => d.id) } },
      data: { closedAt: new Date() },
    });
  }

  // The findings that are true now and have not been spoken about. A DISMISSED
  // or RESOLVED finding is excluded by the status filter, so an owner who waved
  // one away is not told about it again.
  const candidates = await prisma.genesisObservation.findMany({
    where: {
      storeId,
      status: "ACTIVE",
      // An open delivery means J4 has already said this. `none` rather than a
      // join on closedAt: a finding with a closed delivery and no open one is
      // exactly the re-engagement case, and it should be eligible.
      proactiveDeliveries: { none: { closedAt: null } },
    },
    orderBy: { firstNoticedAt: "asc" },
  });

  const chosen = [...candidates]
    .sort((a, b) => {
      const byState =
        (STATE_PRIORITY[a.genesisState] ?? 99) - (STATE_PRIORITY[b.genesisState] ?? 99);
      if (byState !== 0) return byState;
      // Oldest first among equals: a finding that has been true longest is the
      // one the owner has been un-told about for longest.
      return a.firstNoticedAt.getTime() - b.firstNoticedAt.getTime();
    })
    .slice(0, FINDINGS_PER_CYCLE);

  let spoken = 0;
  for (const finding of chosen) {
    const said = await speakOneFinding(storeId, finding);
    if (said) spoken++;
  }

  return { spoken, closed: closable.length };
}

async function speakOneFinding(
  storeId: string,
  finding: { id: string; genesisState: string; summary: string }
): Promise<boolean> {
  const content = proactiveMessageFor(finding);

  // THE EXECUTION ROW FIRST, so the message carries it — the same order and the
  // same reason as persistToolTurn. PENDING, not SUCCESS: J4 has raised
  // something and nothing has changed, which is what UI6's "Waiting for you"
  // state exists to say. Recording this as a success would be claiming a change
  // that was never even proposed.
  const logged = await recordGenesisExecution({
    action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
    status: "PENDING",
    verified: false,
    message: content,
    // Nothing to retry — J4 spoke, and the owner has it.
    retryable: false,
    // No session. The cycle is Genesis acting on its own, which
    // recordGenesisExecution already represents as actorType GENESIS.
    userId: null,
    storeId,
    metadata: { kind: "proactive_finding", observationId: finding.id, genesisState: finding.genesisState },
  });

  try {
    const message = await prisma.storeMessage.create({
      data: { storeId, role: "assistant", content, executionLogId: logged.id },
    });

    await prisma.proactiveDelivery.create({
      data: { storeId, observationId: finding.id, storeMessageId: message.id },
    });
    return true;
  } catch (err) {
    // THE UNIQUE INDEX DID ITS JOB. Two cycles overlapping is the ordinary way
    // this happens, and losing the race is not a failure — it means the owner
    // has already been told. Swallowed deliberately rather than surfaced,
    // because there is nothing wrong and nobody to tell.
    if (isDuplicateDelivery(err)) return false;
    throw err;
  }
}

function isDuplicateDelivery(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}
