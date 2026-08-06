import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { callGenesisModel } from "@/lib/genesisModel";
import { getBusinessProfile } from "@/lib/businessModel/profile";
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

const AssetClassificationSchema = z.object({
  // Free string — "product_photo" | "supplier_invoice" | "contract" |
  // "business_license" | "marketing_flyer" | "sop" | "employee_document" |
  // "financial_statement" | ... — see the system prompt for the full
  // suggested vocabulary. Never z.enum(), matching this codebase's
  // standing "categorical fields stay open" convention (entities.ts).
  category: z.string(),
  summary: z.string(),
  // 0-1. The model's own honest confidence that `category` (and any
  // proposed relatedRecordId) are correct — never a stand-in for "did the
  // call succeed," which is handled separately via outcome.ok.
  confidence: z.number().min(0).max(1),
  relatedRecordId: z.string().nullable(),
  relatedEntityType: z.enum(["item", "contact"]).nullable(),
});
export type AssetClassification = z.infer<typeof AssetClassificationSchema>;

const CLASSIFY_SYSTEM_PROMPT = `You are Genesis (J4), looking at a file a business owner just uploaded — a photo or a document — to understand what it is and extract real, useful business knowledge from it.

Decide:
1. category — a short, specific label for what this actually is. Common values: "product_photo", "supplier_invoice", "customer_invoice", "receipt", "contract", "business_license", "marketing_flyer", "sop" (standard operating procedure), "employee_document", "financial_statement", "logo", "product_spec_sheet" — use one of these when it genuinely fits, or another short, specific label when it doesn't. Never a vague label like "document" or "file."
2. summary — 1-2 real, specific sentences describing what's actually in it (names, amounts, dates, parties — whatever is genuinely visible/readable), not a generic description of the category.
3. confidence — how much real, usable business information you were actually able to extract, not how sure you are about your own read of the file. A clear, legible invoice with a readable amount deserves high confidence. A blurry photo, a partially-legible document, or an unreadable/blank/noise file that gives you nothing real to work with deserves LOW confidence — even if you're completely sure it's unreadable/blank/noise. Being confident that there's nothing usable here is still a low-confidence result, never a high one. Never inflate this to seem helpful.
4. relatedRecordId / relatedEntityType — you're given this business's real current products and known suppliers/customers, each with a real id. Only set these when the file clearly and specifically describes one of them (e.g. an invoice naming a supplier you were given, or a photo that's obviously of one specific listed product) — leave both null whenever the match isn't genuinely clear, rather than guessing.

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
export async function classifyAndExtractAsset(
  record: BusinessRecord,
  storeId: string
): Promise<{ classification: AssetClassification; isHighConfidence: boolean } | null> {
  try {
    const data = record.data as Asset;
    const profile = await getBusinessProfile(storeId);

    const referenceContext = {
      products: profile.offerings.items.map((i) => ({ id: i.id, name: i.data.name })),
      suppliers: profile.suppliers.map((c) => ({ id: c.id, name: c.data.name })),
      topCustomers: profile.customers.topContacts.map((c) => ({ id: c.contact.id, name: c.contact.data.name })),
    };

    const fileContentBlock =
      data.fileType === "document"
        ? ({ type: "document" as const, source: { type: "url" as const, url: data.storageUrl } })
        : ({ type: "image" as const, source: { type: "url" as const, url: data.storageUrl } });

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

    return { classification, isHighConfidence };
  } catch (err) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureException(err);
    return null;
  }
}
