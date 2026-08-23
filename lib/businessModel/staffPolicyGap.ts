import { queryRecords } from "@/lib/businessModel/reasoning";
import { upsertObservation, resolveMissingObservations } from "@/lib/dashboard/genesisObservations";

// J4 ASKS FOR THE ONE DOCUMENT IT CAN JUSTIFY WANTING (2026-08-23).
//
// J4_IDENTITY.md freezes "how J4 asks for what it's missing" and its governing
// test: "a real, specific reason already in evidence, never a category of
// information that's generically nice to have." Of the three documents that
// document names, only this one passes on evidence the system actually holds —
// employees are a real recorded entity, and nothing anywhere records whether a
// business has premises, so a lease ask would be exactly the generic checklist
// the principle exists to prevent.
//
// NOT A DOCUMENT-REQUEST SYSTEM. There is no registry of documents, no
// per-document configuration, and nothing here generalises. It is one gap,
// computed from two reads, expressed in the finding representation that already
// exists — which is what carries it to the owner through Proactive J4, closes it
// when it is satisfied, and keeps it honest afterwards. Adding a second document
// later should be a decision, not a config entry.

/**
 * What a document about how a business runs its people looks like when it lands.
 *
 * MATCHED AS A SET, NOT A STRING, and that is load-bearing. Asset categories are
 * a deliberately OPEN vocabulary — lib/businessAssets/classify.ts names common
 * values and then tells the classifier to invent "another short, specific label"
 * when none fits. Waiting for one exact spelling would mean an owner uploads
 * their handbook, it classifies as `sop` or `employee_document`, and J4 keeps
 * asking for the thing it is already holding. A gap that cannot close is worse
 * than a gap never raised.
 *
 * Deliberately broad in the direction of stopping. A false match costs one
 * unasked question; a false miss costs J4 asking forever for a document the
 * owner has already given it.
 */
const STAFF_POLICY_CATEGORY = /handbook|employee[_\s-]?doc|staff|policy|policies|\bsop\b|onboarding/i;

export function isStaffPolicyDocument(asset: { fileType?: unknown; category?: unknown }): boolean {
  // A photo of the staff is not a policy. The category alone would match
  // "staff_photo", which is why the file type is checked first.
  if (asset.fileType !== "document") return false;
  return typeof asset.category === "string" && STAFF_POLICY_CATEGORY.test(asset.category);
}

/** The one finding this file owns, so a sweep only ever resolves its own row. */
export const STAFF_POLICY_TOPIC = "document_gap:staff_policy";

export interface StaffPolicyGap {
  /** How many people are on record. The evidence, and it goes in the sentence. */
  activeEmployees: number;
}

/**
 * Whether asking for a handbook is justified for THIS business right now.
 *
 * The evidence is people. Not a business category, not a size band, not "most
 * businesses have one" — actual employees the owner has recorded, which is a
 * specific fact about them rather than a fact about businesses in general. A
 * business with nobody on record gets asked nothing, forever, and that is the
 * correct outcome rather than a coverage gap.
 */
export async function getStaffPolicyGap(storeId: string): Promise<StaffPolicyGap | null> {
  const [employees, assets] = await Promise.all([
    queryRecords(storeId, "employee"),
    queryRecords(storeId, "asset"),
  ]);

  // Former staff are not evidence that policies are live. An owner who recorded
  // two people who have since left is not running a team today.
  const active = employees.filter((e) => {
    const status = (e.data as { status?: unknown } | null)?.status;
    // Unknown status counts as active: the field is nullable, and treating
    // "not stated" as "gone" would silently drop real staff from the evidence.
    return status === null || status === undefined || status === "active";
  });
  if (active.length === 0) return null;

  const alreadyHave = assets.some((a) => isStaffPolicyDocument((a.data ?? {}) as Record<string, unknown>));
  if (alreadyHave) return null;

  return { activeEmployees: active.length };
}

/**
 * The sentence, assembled from the evidence.
 *
 * Says the specific reason out loud — the frozen test is that the ask carries
 * its own justification, so an owner can tell it is about them rather than about
 * businesses like them. Names no mechanism: no "finding", no "gap", no category.
 */
export function staffPolicyAsk(gap: StaffPolicyGap): string {
  const people =
    gap.activeEmployees === 1 ? "one person on your team" : `${gap.activeEmployees} people on your team`;
  // "recorded" was here and came out in the first run of the suite's own
  // no-internals check. It is J4 talking about its database: a partner says
  // "you've got three people", not "you've got three people recorded."
  return `You've got ${people} and I don't have anything about how you actually run things — would you like to upload your employee handbook so I can understand your policies?`;
}

/**
 * Raise it, or clear it, in the representation the conversation already reads.
 *
 * Idempotent by upsert on (storeId, dedupeKey), like every other finding sweep:
 * running twice raises one row. Proactive J4 then speaks it exactly once and
 * closes its delivery when this resolves — none of which is implemented here,
 * because none of it is specific to this gap.
 */
export async function proposeStaffPolicyGap(storeId: string): Promise<void> {
  const gap = await getStaffPolicyGap(storeId);

  if (gap) {
    await upsertObservation(storeId, {
      dedupeKey: STAFF_POLICY_TOPIC,
      // Never urgent. A missing handbook is not something going wrong, and
      // Proactive J4's ordering already keeps it behind anything that is.
      genesisState: "opportunity",
      summary: staffPolicyAsk(gap),
      actionHref: null,
    });
  }

  // SATISFIED MEANS SILENT. Uploading the handbook — or the last employee
  // leaving — removes the evidence, which resolves the finding, which closes
  // the delivery. The message J4 already sent stays exactly where it is: what it
  // asked for was true when it asked.
  //
  // Scoped to this one topic so it can never resolve another sweep's
  // opportunity findings.
  await resolveMissingObservations(
    storeId,
    gap ? [STAFF_POLICY_TOPIC] : [],
    "opportunity",
    STAFF_POLICY_TOPIC
  );
}
