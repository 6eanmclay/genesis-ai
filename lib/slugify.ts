// A business name becomes a URL: its storefront at /store/<slug> and its own
// workspace at /b/<slug>.
//
// DIACRITICS ARE FOLDED, NOT DROPPED (2026-08-22). "Café Noël" used to become
// "caf-no-l", because every accented character fell through the a-z0-9 filter
// and was replaced by a dash. Normalising to NFD first splits each one into a
// base letter plus a combining mark, so stripping the marks leaves the letter —
// "cafe-noel". Applied at creation time only, so no existing slug moves.
//
// WHAT THAT STILL CANNOT DO, and deliberately. NFD decomposes a letter that is
// a base plus an accent; it does nothing for letters that are DISTINCT
// characters — ß, ø, æ, đ — which still fall through to a separator. Mapping
// those would mean inventing a language-by-language transliteration table with
// no agreed contents and no end. The slug stays usable either way, which is the
// requirement.
//
// AND A NAME WITH NO LATIN LETTERS AT ALL returns an EMPTY STRING — 工房,
// الحرفي, Мастерская. That is the honest answer from a function that maps to
// a-z0-9, and it is why the caller decides what to name such a business rather
// than this deciding for it. See createStoreFromDraft, which falls back rather
// than writing an empty slug: an empty one made the storefront /store/ and the
// workspace /b/, which is not a business path at all.
export function slugify(name: string) {
  return name
    .normalize("NFD")
    // Combining marks left behind by the decomposition above.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
