import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "crypto";
import mammoth from "mammoth";
import { callGenesisModel } from "@/lib/genesisModel";
import { getBusinessProfile } from "@/lib/businessModel/profile";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { planCommitments, recordCommitments } from "./commitments";
import { EmployeeCaptureSchema, LocationCaptureSchema } from "@/lib/businessModel/factCapture";
import { prisma } from "@/lib/prisma";
import type { BusinessRecord } from "@prisma/client";
import type { Asset } from "@/lib/businessModel/entities";

// Business Assets M3 — real classification and extraction, one
// callGenesisModel call per uploaded asset, given the actual image/
// document content (not just its filename) plus real existing records
// (products, suppliers, top customers) to match against. A moderate,
// reasoned starting confidence bar — not tuned from real usage data yet,
// explicitly not claimed as final (see the plan's own note on this).
const CONFIDENCE_THRESHOLD = 0.6;

// Business Assets M5 — reuses factCapture.ts's own Employee/Location
// capture shapes (the same real contract chat's business-fact capture
// already writes from) rather than re-declaring them; adds the two shapes
// that module doesn't cover — a new contact (supplier/customer) and a
// campaign — plus a product shape whose priceInCents is nullable, unlike
// create_product's own real inputSchema, since a file may name a product
// without ever stating its price (see the caller for why that case never
// becomes an ApprovalRequest).
const ContactCaptureSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  // "customer" | "vendor" — matches ContactSchema's own open roles array.
  roles: z.array(z.string()),
});
const CampaignCaptureSchema = z.object({
  name: z.string(),
  channel: z.string(),
});
const ProductCaptureSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  priceInCents: z.number().int().nullable(),
});

// A DATED COMMITMENT READ OUT OF THE FILE (2026-08-21).
//
// Deliberately NOT part of NewEntityProposalSchema below. That field answers
// "what IS this file", and is mutually exclusive with relatedRecordId by
// design — never both a match and a new-entity proposal at once. A commitment
// is not an identity for the file, it is a FACT INSIDE it: a lease can match a
// supplier already known AND carry a renewal date, and folding the two together
// would mean losing the date exactly when the document was best understood.
//
// An array, because one contract routinely carries several dates.
//
// dueDate has no null branch anywhere in this pipeline. The prompt says it, the
// schema says it, and the writer below drops anything that arrives without one
// — a commitment with no date is a sentence, and the summary already holds the
// sentences.
const CommitmentCaptureSchema = z.object({
  title: z.string(),
  kind: z.string(),
  dueDate: z.string(),
  counterparty: z.string().nullable(),
  amountInCents: z.number().int().nullable(),
  sourceQuote: z.string(),
});

const NewEntityProposalSchema = z.discriminatedUnion("entityType", [
  z.object({ entityType: z.literal("contact"), data: ContactCaptureSchema }),
  z.object({ entityType: z.literal("employee"), data: EmployeeCaptureSchema }),
  z.object({ entityType: z.literal("location"), data: LocationCaptureSchema }),
  z.object({ entityType: z.literal("campaign"), data: CampaignCaptureSchema }),
  z.object({ entityType: z.literal("product"), data: ProductCaptureSchema }),
]);

const AssetClassificationSchema = z.object({
  // Free string — "product_photo" | "supplier_invoice" | "contract" |
  // "business_license" | "marketing_flyer" | "sop" | "employee_document" |
  // "financial_statement" | ... — see the system prompt for the full
  // suggested vocabulary. Never z.enum(), matching this codebase's
  // standing "categorical fields stay open" convention (entities.ts).
  category: z.string(),
  summary: z.string(),
  // 0-1. The model's own honest confidence that `category` (and any
  // proposed relatedRecordId/newEntity) are correct — never a stand-in
  // for "did the call succeed," which is handled separately via
  // outcome.ok.
  confidence: z.number().min(0).max(1),
  relatedRecordId: z.string().nullable(),
  relatedEntityType: z.enum(["item", "contact"]).nullable(),
  // Set only when relatedRecordId is null AND the file clearly, specifically
  // describes one genuinely new real-world entity worth adding to this
  // business's own records — never both a match and a new-entity proposal
  // at once. See NewEntityProposalSchema's own comment for why "product"
  // is shaped differently from the other four.
  newEntity: NewEntityProposalSchema.nullable(),
  // Independent of everything above: a file can be matched to a known supplier
  // and still state a renewal date, and both are worth keeping.
  commitments: z.array(CommitmentCaptureSchema),
});
export type AssetClassification = z.infer<typeof AssetClassificationSchema>;

const CLASSIFY_SYSTEM_PROMPT = `You are Genesis (J4), looking at a file a business owner just uploaded — a photo or a document — to understand what it is and extract real, useful business knowledge from it. The goal is never just to summarize the file — it's to permanently grow what you actually know about this business, the same way a fact stated directly in chat would.

Decide:
1. category — a short, specific label for what this actually is. Common values: "product_photo", "supplier_invoice", "customer_invoice", "receipt", "contract", "business_license", "marketing_flyer", "sop" (standard operating procedure), "employee_document", "financial_statement", "logo", "product_spec_sheet" — use one of these when it genuinely fits, or another short, specific label when it doesn't. Never a vague label like "document" or "file."
2. summary — 1-2 real, specific sentences describing what's actually in it (names, amounts, dates, parties — whatever is genuinely visible/readable), not a generic description of the category.
3. confidence — how much real, usable business information you were actually able to extract, not how sure you are about your own read of the file. A clear, legible invoice with a readable amount deserves high confidence. A blurry photo, a partially-legible document, or an unreadable/blank/noise file that gives you nothing real to work with deserves LOW confidence — even if you're completely sure it's unreadable/blank/noise. Being confident that there's nothing usable here is still a low-confidence result, never a high one. Never inflate this to seem helpful.
4. relatedRecordId / relatedEntityType — you're given this business's real current products and known suppliers/customers, each with a real id. Only set these when the file clearly and specifically describes one of them (e.g. an invoice naming a supplier you were given, or a photo that's obviously of one specific listed product) — leave both null whenever the match isn't genuinely clear, rather than guessing.
5. newEntity — only when relatedRecordId is null (nothing existing matched) and the file clearly, specifically describes ONE genuinely new real-world business entity worth remembering: a supplier or customer not already known (entityType "contact", with real roles like ["vendor"] or ["customer"]), a new employee ("employee"), a new business location ("location"), a new marketing campaign ("campaign"), or a new sellable product ("product"). Only propose this when the file is genuinely specific and clear about it — a real name plus real identifying detail, never a vague mention. Leave newEntity null for anything that doesn't cleanly fit one of these five, including contracts, policies, licenses, and SOPs — those stay real, useful, understood assets on their own; forcing them into the wrong entity type would be worse than leaving them as an asset.

6. commitments — real DATED DEADLINES this business is bound by, stated in the file: a lease expiry, an insurance or licence renewal, a contract term end, a tax deadline, a warranty end. This is the one thing that must survive the file being closed, because nobody remembers it otherwise. For each: title (what falls due), kind ("lease" | "insurance" | "licence" | "contract" | "tax" | "warranty" | "subscription" | "other"), dueDate as YYYY-MM-DD, counterparty when the file names one, amountInCents when the file states an amount, and sourceQuote — the exact sentence from the file that states the date, copied verbatim so the owner can check it.

   AN ACTUAL DATE OR NOTHING. If the file describes a term without stating when it ends ("a twelve-month lease", "renews annually"), that is NOT a commitment — do not compute one, do not assume a start date, return no entry for it. A wrong deadline is worse than no deadline: the owner would trust it and miss the real one. Return [] whenever the file states no dates, which is most files.

Never fabricate a number, name, or date that isn't actually legible in the file. If the file is unreadable, unrelated to the business, or you genuinely can't tell what it is, say so honestly in the summary and set confidence low.`;

// The whole body is wrapped in try/catch and degrades to null on any
// failure — a real bug here (found live: an early version's own
// BusinessRecord.update omitted storeId and tripped lib/tenantIsolation.ts's
// guard) must never crash the upload turn itself. The upload already
// succeeded (M1/M2's ingestBusinessAsset); a classification failure is
// exactly the "I've saved it, but couldn't take a proper look" case
// uploadBusinessAssetFromChat's own null-result branch already handles —
// never a thrown error that leaves the owner staring at a network-failure
// banner under a message that actually already succeeded.
export interface CreatedAssetEntity {
  entityType: "contact" | "employee" | "location" | "campaign";
  recordId: string;
  name: string;
}
export interface AssetProductProposal {
  name: string;
  description: string | null;
  priceInCents: number | null;
}

export interface AssetClassificationResult {
  classification: AssetClassification;
  isHighConfidence: boolean;
  // Set when a genuinely new contact/employee/location/campaign was
  // confidently discovered and directly written — see the newEntity
  // handling below for why this is a direct write, same trust model as
  // STORE_CHAT_BUSINESS_FACT's own goal/challenge/employee/location
  // capture (internal understanding, not customer-facing, self-correcting
  // next turn).
  createdEntity: CreatedAssetEntity | null;
  // Dated commitments actually written from this file (2026-08-21) — what was
  // persisted, never what the model proposed. Empty is the ordinary case: most
  // files state no dates, and one that states a term without a date states no
  // deadline (see planCommitments' refusals).
  commitments: { recordId: string; title: string; dueDate: string }[];
  // Set when a genuinely new, sellable product was confidently identified
  // — never written directly (an "item" BusinessRecord is computed live
  // from the real Product table, see lib/businessModel/internalMapper.ts;
  // writing one here would create a phantom record with no real product
  // behind it). The caller turns this into a real create_product
  // ApprovalRequest, exactly like every other customer-facing/storefront
  // proposal in this app — owner review required, never auto-applied.
  productProposal: AssetProductProposal | null;
}

export async function classifyAndExtractAsset(
  record: BusinessRecord,
  storeId: string
): Promise<AssetClassificationResult | null> {
  try {
    const data = record.data as Asset;
    const profile = await getBusinessProfile(storeId);

    const referenceContext = {
      products: profile.offerings.items.map((i) => ({ id: i.id, name: i.data.name })),
      suppliers: profile.suppliers.map((c) => ({ id: c.id, name: c.data.name })),
      topCustomers: profile.customers.topContacts.map((c) => ({ id: c.contact.id, name: c.contact.data.name })),
    };

    // DOCX support (2026-08-09) — confirmed against Anthropic's current
    // docs: the document content block reads PDFs natively but does NOT
    // read .docx (binary Office formats must be converted to text or PDF
    // first). Real support, not a workaround: extract the file's actual
    // text server-side (mammoth) and hand Claude that text directly,
    // rather than silently rejecting a real business document. Detected
    // by filename since Asset carries no separate contentType field —
    // ALLOWED_CONTENT_TYPES only ever let a real .docx reach fileType
    // "document" in the first place (see uploadAssetFile.ts).
    const isDocx = data.fileType === "document" && data.originalFilename.toLowerCase().endsWith(".docx");
    let fileContentBlock:
      | { type: "text"; text: string }
      | { type: "document"; source: { type: "url"; url: string } }
      | { type: "image"; source: { type: "url"; url: string } };
    if (isDocx) {
      const fileBytes = await (await fetch(data.storageUrl)).arrayBuffer();
      const { value: extractedText } = await mammoth.extractRawText({ buffer: Buffer.from(fileBytes) });
      fileContentBlock = { type: "text", text: `[Extracted text from "${data.originalFilename}"]\n\n${extractedText}` };
    } else if (data.fileType === "document") {
      fileContentBlock = { type: "document", source: { type: "url", url: data.storageUrl } };
    } else {
      fileContentBlock = { type: "image", source: { type: "url", url: data.storageUrl } };
    }

    const outcome = await callGenesisModel(
      {
        model: "claude-opus-4-8",
        max_tokens: 1000,
        thinking: { type: "adaptive" },
        system: CLASSIFY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              fileContentBlock,
              {
                type: "text",
                text: `Filename: ${data.originalFilename}\n\nThis business's real current products and known contacts, for matching (JSON):\n${JSON.stringify(referenceContext, null, 2)}`,
              },
            ],
          },
        ],
        output_config: { effort: "medium", format: zodOutputFormat(AssetClassificationSchema) },
      },
      { storeId, feature: "business_asset_classification" }
    );

    if (!outcome.ok || !outcome.message.parsed_output) return null;

    const classification = outcome.message.parsed_output;
    const isHighConfidence = classification.confidence >= CONFIDENCE_THRESHOLD;

    const updatedData: Asset = {
      ...data,
      // Category/association are only committed as authoritative once
      // confident — a low-confidence guess about WHAT this is shouldn't
      // become the stored classification. The summary is kept either way
      // (M4's clarifying question quotes it — "it looks like X, but I'm
      // not sure" is more useful than nothing), and confidence itself
      // always carries the honest uncertainty.
      category: isHighConfidence ? classification.category : "unclassified",
      summary: classification.summary,
      extractionConfidence: classification.confidence,
      relatedRecordId: isHighConfidence ? classification.relatedRecordId : null,
      relatedEntityType: isHighConfidence ? classification.relatedEntityType : null,
    };

    await prisma.businessRecord.update({
      where: { id: record.id, storeId },
      data: { data: updatedData },
    });

    let createdEntity: CreatedAssetEntity | null = null;
    let productProposal: AssetProductProposal | null = null;

    // DATED COMMITMENTS, written independently of everything below (2026-08-21).
    //
    // Gated on confidence for the same reason category is: a document legible
    // enough to misread is a document whose dates can be misread. Not gated on
    // relatedRecordId — a lease that matched a supplier already known is exactly
    // the case where the renewal date matters most, and the newEntity branch
    // below would have thrown it away.
    const commitments = isHighConfidence
      ? await recordCommitments(
          storeId,
          planCommitments({
            raw: classification.commitments,
            assetRecordId: record.id,
            confidence: classification.confidence,
          })
        )
      : [];

    // Only when confident, and only when nothing existing already matched
    // — newEntity and relatedRecordId are never both meaningful at once
    // (the prompt already asks for this, this is the same defense-in-depth
    // this codebase applies everywhere a model output feeds a real write).
    if (isHighConfidence && !classification.relatedRecordId && classification.newEntity) {
      const proposal = classification.newEntity;
      const todayIso = new Date().toISOString().slice(0, 10);

      if (proposal.entityType === "product") {
        productProposal = {
          name: proposal.data.name,
          description: proposal.data.description,
          priceInCents: proposal.data.priceInCents,
        };
      } else {
        const recordData =
          proposal.entityType === "contact"
            ? { ...proposal.data, firstSeenAt: todayIso, lastSeenAt: todayIso }
            : proposal.entityType === "employee"
              ? { ...proposal.data, status: "active", locationId: null }
              : proposal.entityType === "location"
                ? proposal.data
                : { ...proposal.data, sentAt: null, audienceSize: null, metrics: null }; // campaign

        const { changes } = await persistSyncedRecords(
          storeId,
          "genesis_upload",
          [{ entityType: proposal.entityType, externalId: randomUUID(), data: recordData }],
          {
            // The owner's own document is the evidence; a model decided what it
            // said. Both halves are true, and recording only the first would let
            // an extraction read back later as something the owner stated.
            provenance: "DOCUMENT",
            provenanceDetail: record.id,
            statedById: null,
            modelExtracted: true,
          }
        );
        if (changes[0]) {
          createdEntity = {
            entityType: proposal.entityType,
            recordId: changes[0].recordId,
            name: proposal.data.name,
          };
        }
      }
    }

    return { classification, isHighConfidence, createdEntity, productProposal, commitments };
  } catch (err) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(err);
    return null;
  }
}
