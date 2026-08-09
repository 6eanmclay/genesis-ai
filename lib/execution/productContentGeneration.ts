import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { callGenesisModel } from "@/lib/genesisModel";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";

// J4 approvable product content changes (2026-08-09) — "J4 should not
// blindly rewrite these based only on the existing text. It needs to
// understand what the actual product is and what the owner means by it"
// (Sean, citing real Cúbit & Coil catalog examples — keyword-stuffed
// names, and a real correction that "ATP Maxing" is a real book he
// authored and sells, not an unknown/placeholder product). Grounded the
// same real way lib/marketing/campaigns.ts's own content generation
// already is: the store's actual business understanding (brand identity,
// beliefs, recent decisions), not the product's existing text in
// isolation — plus the owner's own real request text, so an explicit
// instruction ("keep mentioning it's handmade") is honored, not just a
// generic rewrite.
const ProductContentSuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      productId: z.string(),
      name: z.string().nullable(),
      description: z.string().nullable(),
      reasoning: z.string(),
    })
  ),
});

const PRODUCT_CONTENT_SYSTEM_PROMPT = `You are Genesis (J4), preparing real, specific proposed changes to one or more existing products' name and/or description for the owner's own review and approval — you are not applying anything yet, just preparing what you'd recommend.

Ground every suggestion in the real business understanding you're given (brand identity, voice and tone, target audience, beliefs, recent decisions) and in what the product actually IS, not just a mechanical rewrite of its existing text. A keyword-stuffed name ("Copper Tensor Ring Bracelet - 11AWG Sacred Cubit Energy Enhancing Jewelry for Spiritual Well-being & Balance Trendy Stack Bangle Faith Wear") should become something a real customer would actually want to read, in the business's own real brand voice — not a shorter version of the same keyword list. If a product's existing text already reads as something specific and real (a real book title, a real named item), do not treat it as generic or unknown — preserve what's actually true about it.

If the merchant's own message gives you specific guidance (a tone to use, a claim to keep or avoid, a correction about what something actually is), follow it exactly — their own words about their own business always take precedence over your own inference.

Only propose a genuine improvement — if a product's current name or description is already good, it is completely fine to propose leaving it unchanged (return null for that field) rather than changing something for its own sake.

For each product, write one real, specific, one-sentence reasoning naming why the change helps (never a generic "improves clarity" — say what specifically was wrong and what specifically is better now).`;

export interface ProductContentSuggestion {
  productId: string;
  name: string | null;
  description: string | null;
  reasoning: string;
}

export async function generateProductContentChanges(params: {
  storeId: string;
  products: { id: string; name: string; description: string | null; priceInCents: number }[];
  changeType: "name" | "description" | "both";
  ownerRequest: string;
}): Promise<ProductContentSuggestion[]> {
  const understanding = await getBusinessUnderstanding(params.storeId);

  const fieldsToChange =
    params.changeType === "both" ? "name and description" : params.changeType === "name" ? "only the name" : "only the description";

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      system: PRODUCT_CONTENT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `The owner asked: "${params.ownerRequest}"\n\n` +
            `Propose ${fieldsToChange} for each of these products. Leave the field(s) you weren't asked to change as null.\n\n` +
            `Products (JSON):\n${JSON.stringify(params.products, null, 2)}\n\n` +
            `Business understanding (JSON):\n${JSON.stringify(
              { businessProfile: understanding.profile, beliefs: understanding.beliefs, recentDecisions: understanding.recentDecisions },
              null,
              2
            )}`,
        },
      ],
      output_config: { effort: "medium", format: zodOutputFormat(ProductContentSuggestionSchema) },
    },
    { storeId: params.storeId, feature: "product_content_generation" }
  );

  if (!outcome.ok) return [];
  return outcome.message.parsed_output?.suggestions ?? [];
}
