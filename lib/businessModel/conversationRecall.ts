import { prisma } from "@/lib/prisma";

// M9 (2026-08-19) — J4 remembers what the owner told it.
//
// THE GAP. Every read of StoreMessage in this codebase is a recency window —
// five call sites, all `orderBy createdAt desc, take N`, with the chat window
// at 50. There was no search over conversation history anywhere. So anything
// the owner said more than fifty messages ago was unreachable forever, while
// sitting in the database. And capture_business_fact only accepts goal,
// challenge, employee and location, so "my wax supplier raised prices 12% in
// June" had no home either: not a goal, not a challenge, and gone from the
// window within a week of normal use.
//
// THIS IS GAP D'S TWIN. Sean's instruction when decision recall was fixed:
// "specific decision recall should be topic/context-searchable rather than
// constrained by a fixed time window... Keep recency as a ranking signal, not a
// hard cutoff." That principle was applied to decisions and never extended to
// the conversation those decisions came out of — J4 could say why it rejected a
// rename in January and not what the owner said about their supplier last
// month.
//
// DELIBERATELY DETERMINISTIC. No embeddings, no model classification, no
// summarisation, no new entity type. findRelevantDecisions already proved
// token-overlap scoring works on this codebase's own data; this is the same
// shape applied to a different table.
//
// A SIBLING, NOT AN EDIT. reasoning.ts and its decision recall are frozen, so
// nothing here touches them. That includes the tokeniser: reasoning.ts's own is
// private and its stopword list is tuned for decision phrasing ("decide",
// "decided", "decision"), which are meaningful words in a conversation query.
// Independent by design rather than duplicated by accident.

/**
 * Owner messages only, per Sean's decision.
 *
 * Load-bearing, and asserted by the suite: J4's own words are not evidence of
 * what the owner told it. Without this filter an assistant message that happens
 * to contain the right keywords would score and be quoted back as something the
 * owner said.
 */
export const OWNER_MESSAGE_ROLE = "user";

/** Bounded like findRelevantDecisions' own history cap, for the same reason. */
const HISTORY_CAP = 1000;

const CONVERSATION_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "to", "of", "in", "on",
  "we", "i", "you", "my", "our", "it", "that", "this", "then", "than",
  "was", "were", "is", "are", "be", "been", "am", "about", "why", "what",
  "when", "how", "who", "which", "there", "here", "have", "has", "had",
  "said", "say", "tell", "told", "remember", "ago", "back", "again", "just",
  "can", "could", "would", "should", "will", "get", "got", "much", "many",
  // Auxiliaries carry no subject to match on. Their absence was a real bug the
  // suite caught: "what DID my wax supplier do about prices" matched "What DID
  // I make last week?" on the word "did" alone, at relevance 0.25 — a confident
  // recall of something entirely unrelated. reasoning.ts's own stopword list
  // strips these for the same reason; this list simply had not.
  "did", "does", "doing", "done", "not",
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !CONVERSATION_STOPWORDS.has(w));
}

export interface RecalledStatement {
  /** ISO timestamp of when the owner said it. */
  saidAt: string;
  /** Whole days ago, so J4 can say "back in June" without doing arithmetic. */
  ageDays: number;
  /**
   * The owner's own words, VERBATIM. Not truncated, not tidied, not
   * paraphrased — per Sean's decision, retrieval preserves original wording.
   * Quoting someone's own sentence back to them is the whole value; a
   * paraphrase at this layer would launder what they actually said.
   */
  text: string;
  relevance: number;
}

export interface StatementRow {
  content: string;
  createdAt: Date;
}

/**
 * Rank the owner's past statements against a question — pure.
 *
 * NO DATE FILTER ANYWHERE. Recency is a nudge of at most +0.1, halving roughly
 * every three months, so a highly relevant statement from a year ago outranks a
 * barely relevant one from yesterday. That asymmetry is the entire point: a
 * fixed window is exactly what this milestone exists to remove.
 *
 * An empty result is a real answer. Returning the newest thing the owner
 * happened to say, dressed up as an answer to a question it has nothing to do
 * with, is worse than saying nothing.
 */
export function rankStatements(params: {
  statements: StatementRow[];
  query: string;
  now: Date;
  limit?: number;
  minRelevance?: number;
}): RecalledStatement[] {
  const { statements, query, now } = params;
  const limit = params.limit ?? 5;
  const minRelevance = params.minRelevance ?? 0.12;

  const queryTokens = tokenise(query);
  // A question made only of stopwords carries no subject to match on. Fishing
  // through history for it would return whatever happened to be longest.
  if (queryTokens.length === 0) return [];

  const scored: (RecalledStatement & { rank: number })[] = [];

  for (const row of statements) {
    const haystack = tokenise(row.content);
    if (haystack.length === 0) continue;
    const haystackSet = new Set(haystack);

    let hits = 0;
    for (const token of queryTokens) {
      if (haystackSet.has(token)) {
        hits += 1;
        continue;
      }
      // Partial credit for stem-ish matches ("supplier" / "suppliers"), the
      // same allowance findRelevantDecisions makes.
      if (haystack.some((h) => h.startsWith(token) || token.startsWith(h))) hits += 0.5;
    }

    const relevance = Math.min(1, hits / queryTokens.length);
    if (relevance < minRelevance) continue;

    const ageDays = Math.max(0, Math.round((now.getTime() - row.createdAt.getTime()) / 86_400_000));
    const recencyNudge = 0.1 / (1 + ageDays / 90);

    scored.push({
      saidAt: row.createdAt.toISOString(),
      ageDays,
      text: row.content,
      relevance: Number(relevance.toFixed(2)),
      rank: relevance + recencyNudge,
    });
  }

  return scored
    .sort((a, b) => b.rank - a.rank || a.saidAt.localeCompare(b.saidAt))
    .slice(0, limit)
    // rank is the internal ordering score (relevance + recency nudge) and is
    // deliberately not published: J4 should reason about relevance and age as
    // separate real signals, not about a blended number it cannot interpret.
    .map((s) => ({ saidAt: s.saidAt, ageDays: s.ageDays, text: s.text, relevance: s.relevance }));
}

/**
 * What the owner has said that bears on this question, at any age.
 *
 * Searches ALL of their history rather than excluding whatever is already in
 * the recent window: replicating the window's own arithmetic here would couple
 * two modules, and a relevant statement appearing twice is harmless where
 * dropping one is not.
 */
export async function findRelevantMessages(
  storeId: string,
  query: string,
  opts: { limit?: number; minRelevance?: number } = {}
): Promise<RecalledStatement[]> {
  const statements = await prisma.storeMessage.findMany({
    where: { storeId, role: OWNER_MESSAGE_ROLE },
    orderBy: { createdAt: "desc" },
    take: HISTORY_CAP,
    select: { content: true, createdAt: true },
  });

  return rankStatements({ statements, query, now: new Date(), ...opts });
}
