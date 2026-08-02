import { GeneratedImageProvider } from "./generatedImageProvider";
import type { GenesisModelScope } from "@/lib/genesisModel";

// Business Identity Generation (see memory
// project_arrival_experience_milestone.md) — every business gets its own
// generated icon/avatar at creation, visually distinct from Genesis's own
// permanent avatar. Calls GeneratedImageProvider directly, not through
// resolveProductImage's provider chain — a stock photo is never an honest
// answer to "this business's icon," so there's no fallback provider to
// chain to. Same honest-null convention as every other image call in this
// codebase: a real failure (missing key, moderation rejection, transient
// API error) just means Store.logoUrl stays unset, never a fabricated
// placeholder.
export async function generateBusinessIcon(opts: {
  businessName: string;
  vision: string;
  brandPersonality?: string | null;
  // Unused today — GeneratedImageProvider calls OpenAI, not
  // callGenesisModel — but ImageSourceRequest carries it on every request
  // as the one shared shape every provider conforms to (see that
  // interface's own comment), so this stays required for consistency
  // rather than special-cased away.
  scope: GenesisModelScope;
}): Promise<string | null> {
  const prompt = [
    `A clean, modern, iconic app-style logo/avatar for a business called "${opts.businessName}".`,
    `Business vision: ${opts.vision}.`,
    opts.brandPersonality ? `Brand personality: ${opts.brandPersonality}.` : null,
    "Square format, simple and recognizable at small sizes, no text or letters, centered composition, solid or softly gradiented background — a mark this business could use as its icon everywhere, not a photograph or a scene.",
  ]
    .filter(Boolean)
    .join(" ");

  const result = await GeneratedImageProvider.source({
    prompt,
    name: opts.businessName,
    description: opts.vision,
    excludeUrls: [],
    scope: opts.scope,
  });

  return result?.url ?? null;
}
