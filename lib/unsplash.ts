// Placeholder product imagery until real upload/AI image generation exists.
// Resolved once at product-creation time (not on every page load) — see
// callers in app/dashboard/ai-actions.ts and app/dashboard/actions.ts.

async function searchOnce(query: string, accessKey: string): Promise<string | null> {
  try {
    const url = new URL("https://api.unsplash.com/search/photos");
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", "1");
    url.searchParams.set("orientation", "squarish");

    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${accessKey}` },
    });
    if (!response.ok) return null;

    const data = await response.json();
    const photo = data?.results?.[0];
    return typeof photo?.urls?.regular === "string" ? photo.urls.regular : null;
  } catch {
    return null;
  }
}

// Generated product names are often "{Brand} {Product Type}" (e.g. "Forge
// Adjustable Dumbbell Pair") — verified directly against the API that
// Unsplash's search sometimes returns nothing for the brand-prefixed form
// but succeeds once it's stripped to "Adjustable Dumbbell Pair". Only
// strip on names long enough that the remainder is still meaningful.
function withoutFirstWord(text: string): string | null {
  const words = text.trim().split(/\s+/);
  return words.length >= 3 ? words.slice(1).join(" ") : null;
}

// Unsplash's search has real variance for any single query — verified
// directly against the API that even plain, short, sensible terms
// ("resistance bands") sometimes return zero results while a nearby term
// ("kettlebell") succeeds, and it isn't simply "long queries fail." Rather
// than bet everything on one query, try several candidates in order and
// take the first real hit — the caller's exact candidates (e.g. product
// name, then the AI image prompt) first, then a brand-stripped variant of
// each as a lower-priority fallback. Any failure along the way (missing
// key, no results for that candidate, network error, rate limit) just
// moves to the next candidate, and total failure just means no image,
// which the storefront already handles gracefully.
export async function searchProductImage(
  ...candidates: (string | null | undefined)[]
): Promise<string | null> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) return null;

  const trimmed = candidates.map((c) => c?.trim()).filter((c): c is string => !!c);
  const stripped = trimmed.map(withoutFirstWord).filter((c): c is string => !!c);
  const queries = [...trimmed, ...stripped];

  for (const query of queries) {
    const result = await searchOnce(query, accessKey);
    if (result) return result;
  }

  return null;
}

// Returns up to `count` candidate image URLs for a single query, instead of
// just the first hit — used by lib/productImagery.ts to find a candidate
// that isn't already in an exclusion list (e.g. regenerating a rejected
// product image). Deliberately separate from searchOnce/searchProductImage
// above rather than changing their behavior — those stay exactly as they
// are for the existing creation-time callers.
export async function searchPhotoCandidates(query: string, count: number): Promise<string[]> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) return [];

  try {
    const url = new URL("https://api.unsplash.com/search/photos");
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", String(count));
    url.searchParams.set("orientation", "squarish");

    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${accessKey}` },
    });
    if (!response.ok) return [];

    const data = await response.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    return results
      .map((photo: unknown) => (photo as { urls?: { regular?: unknown } })?.urls?.regular)
      .filter((url: unknown): url is string => typeof url === "string");
  } catch {
    return [];
  }
}
