// WHICH PRODUCTS DOES THE MERCHANT MEAN.
//
// PURE. No database, no model call, no side effects — a list of products and a
// selector in, a resolved set and an account of what could not be resolved out.
//
// ============================ WHY THIS EXISTS ==============================
//
// Three J4 tools already resolve product scope, through one shared helper, and
// that helper understands exactly two things: EVERY product, or an exact list of
// names. It has no way to express the most ordinary sentence a merchant says:
//
//   "Put everything except the T-shirt, hoodie and mug 26% off."
//
// J4 can read that perfectly well — it receives the full product list on every
// turn. What it could not do was SAY it. So the gap was never comprehension, it
// was vocabulary, and this is the vocabulary.
//
// ============================ THE RULE THAT MATTERS ========================
//
// A NAME THAT MATCHES NOTHING IS REPORTED, NEVER DROPPED. If the merchant
// excludes "the mug" and this store has no mug, the honest outcome is not "26%
// off everything else" — it is a question, because the merchant believes they
// own a mug and one of us is wrong. Silently discounting a product they meant
// to protect is exactly the failure this reports its way out of.
//
// The same applies to ambiguity. "Ring" matching eleven products is not a
// selection; it is a question with eleven answers.

/** What a clause selects. */
export type SelectionCriterion =
  | { kind: "all" }
  | { kind: "named"; names: string[] };

export interface ProductSelector {
  include: SelectionCriterion;
  /** Removed from whatever `include` selected. Absent means remove nothing. */
  exclude?: SelectionCriterion;
}

/** A name that matched more than one product, and what it matched. */
export interface AmbiguousName {
  name: string;
  candidates: string[];
}

export interface SelectionResult<T> {
  /** The products the selector resolves to. */
  matched: T[];
  /** Products the exclude clause removed. Named so a summary can say so. */
  excluded: T[];
  /** Names that matched no product at all, from either clause. */
  unmatched: string[];
  /** Names that matched several products, with the candidates. */
  ambiguous: AmbiguousName[];
  /**
   * Whether this selection can be acted on without asking first.
   *
   * False whenever anything was unmatched or ambiguous — see the header. The
   * caller decides what to do about it; this only refuses to hide it.
   */
  resolved: boolean;
}

/** Trimmed and case-folded. The model is repeating a name the merchant typed. */
function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

interface NameMatch<T> {
  exact: T[];
  ambiguous: AmbiguousName | null;
  unmatched: string | null;
}

/**
 * One name against the catalogue.
 *
 * EXACT FIRST, ALWAYS. Only when nothing matches exactly does this fall back to
 * a containment match — so "Copper Mug" wins outright over "Copper Mug Warmer"
 * rather than the two competing. Without that ordering, naming a product
 * precisely would still be ambiguous whenever a longer name contained it.
 */
function matchOne<T extends { name: string }>(products: T[], name: string): NameMatch<T> {
  const wanted = fold(name);
  if (wanted === "") return { exact: [], ambiguous: null, unmatched: null };

  const exact = products.filter((p) => fold(p.name) === wanted);
  if (exact.length > 0) return { exact, ambiguous: null, unmatched: null };

  // A merchant says "the mug", not "Hand-Poured Copper Mug". Containment is how
  // that reaches the right product — but only when it reaches exactly one.
  const contains = products.filter((p) => fold(p.name).includes(wanted));
  if (contains.length === 1) return { exact: contains, ambiguous: null, unmatched: null };
  if (contains.length > 1) {
    return {
      exact: [],
      ambiguous: { name: name.trim(), candidates: contains.map((p) => p.name) },
      unmatched: null,
    };
  }

  return { exact: [], ambiguous: null, unmatched: name.trim() };
}

interface CriterionResult<T> {
  products: T[];
  unmatched: string[];
  ambiguous: AmbiguousName[];
}

function resolveCriterion<T extends { name: string }>(
  products: T[],
  criterion: SelectionCriterion | undefined
): CriterionResult<T> {
  if (!criterion) return { products: [], unmatched: [], ambiguous: [] };
  if (criterion.kind === "all") return { products: [...products], unmatched: [], ambiguous: [] };

  const chosen: T[] = [];
  const unmatched: string[] = [];
  const ambiguous: AmbiguousName[] = [];

  for (const name of criterion.names ?? []) {
    const match = matchOne(products, name);
    if (match.unmatched !== null) unmatched.push(match.unmatched);
    if (match.ambiguous) ambiguous.push(match.ambiguous);
    for (const product of match.exact) {
      // Two names resolving to one product selects it once, not twice.
      if (!chosen.includes(product)) chosen.push(product);
    }
  }

  return { products: chosen, unmatched, ambiguous };
}

/**
 * The products a selector resolves to, and everything that could not be resolved.
 *
 * ORDER IS PRESERVED throughout — the catalogue's own order, which is the
 * merchant's chosen `position`. A selection presented in a different order than
 * the Products page is harder to check, and checking it is the entire point of
 * showing it.
 */
export function resolveSelection<T extends { name: string }>(
  products: T[],
  selector: ProductSelector
): SelectionResult<T> {
  const included = resolveCriterion(products, selector.include);
  const removed = resolveCriterion(products, selector.exclude);

  const removedSet = new Set(removed.products);
  const matched = included.products.filter((p) => !removedSet.has(p));
  // Only the ones that were actually IN the selection to begin with. Excluding
  // a product that was never included is not an exclusion, and reporting it as
  // one would inflate the count the merchant is checking.
  const excluded = included.products.filter((p) => removedSet.has(p));

  const unmatched = [...included.unmatched, ...removed.unmatched];
  const ambiguous = [...included.ambiguous, ...removed.ambiguous];

  return {
    matched,
    excluded,
    unmatched,
    ambiguous,
    resolved: unmatched.length === 0 && ambiguous.length === 0,
  };
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What this selection is, in a sentence the merchant can check against.
 *
 * COUNTS AND NAMES, never "the selected products". The merchant is being asked
 * to catch a mistake, and they cannot catch one in a sentence that does not say
 * what was chosen. Long lists are counted rather than enumerated, because
 * thirteen names in a row is not checkable either.
 */
export function describeSelection<T extends { name: string }>(
  result: SelectionResult<T>,
  options: { totalProducts: number; nameLimit?: number } = { totalProducts: 0 }
): string {
  const limit = options.nameLimit ?? 3;
  const count = result.matched.length;

  if (count === 0) return "No products match that.";

  const subject =
    count <= limit
      ? listNames(result.matched.map((p) => p.name))
      : count === options.totalProducts
        ? `all ${count} products`
        : `${count} products`;

  if (result.excluded.length === 0) return subject;

  const leftOut =
    result.excluded.length <= limit
      ? listNames(result.excluded.map((p) => p.name))
      : `${result.excluded.length} others`;

  return `${subject}, leaving out ${leftOut}`;
}

/**
 * The question to ask when a selection could not be resolved, or null.
 *
 * Grounded in the real catalogue rather than echoing the merchant's own
 * sentence back at them — the defect the scope helpers already carry a comment
 * about, kept fixed here rather than re-learned.
 */
export function selectionProblem<T extends { name: string }>(result: SelectionResult<T>): string | null {
  if (result.ambiguous.length > 0) {
    const first = result.ambiguous[0];
    return `"${first.name}" could mean ${listNames(first.candidates)}. Which did you mean?`;
  }
  if (result.unmatched.length > 0) {
    return result.unmatched.length === 1
      ? `I can't find a product called "${result.unmatched[0]}".`
      : `I can't find products called ${listNames(result.unmatched.map((n) => `"${n}"`))}.`;
  }
  return null;
}
