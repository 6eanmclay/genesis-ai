import { canonicalUrl } from "./references";

// WHO A BLOB BELONGS TO, DERIVED FROM EVIDENCE.
//
// ============ WHY THIS IS ONE IMPLEMENTATION (2026-08-29) ==============
//
// The backfill asks this question to write 327 rows. Reconciliation asks it
// again afterwards to check whether any of those answers has changed. Two
// copies of the derivation would be a mirrored registry in the exact shape
// ARCHITECTURE.md's standing invariant warns about — and worse than most,
// because the two would agree on the day they were written and drift silently
// afterwards, in the direction that assigns somebody else's file to a business.
//
// So there is one. Reconciliation comparing its answer to the backfill's is
// then a real comparison of two moments, rather than a comparison of two
// programs that happen to be reading the same database.
//
// ============ THE RULE, WHICH IS THE WHOLE POINT =======================
//
// A blob belongs to a store because a row owned by that store references its
// URL. Not because of its pathname, not because of who uploaded near it in
// time, and not because one store is the obvious guess.
//
//   exactly one store   -> owner
//   no store            -> unattributed, storeId null
//   two or more stores  -> ambiguous, storeId null
//
// The last two are the same answer wearing different labels: we do not know, so
// nobody is charged for it and nobody's file is at risk.

/** The narrow slice of a Prisma client this needs. Keeps it importable anywhere. */
export interface RawQueryable {
  $queryRawUnsafe<T = unknown>(sql: string, ...args: unknown[]): Promise<T>;
}

export interface AttributionScan {
  /** canonical url -> the distinct stores that reference it. */
  stores: Map<string, Set<string>>;
  /** canonical url -> one place it was found, so a person can go and look. */
  evidence: Map<string, string>;
  columnsScanned: number;
  columnsSkipped: string[];
  tier1Tables: number;
  tier2Joins: string[];
}

/** Double-quote an identifier, refusing anything that is not one. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to build a query around an unexpected identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Sweep the whole schema for references to stored files, and record who holds
 * each one.
 *
 * ============ IT ASKS THE SCHEMA, IT DOES NOT LIST TABLES ==============
 *
 * lib/storage/scan.ts opens with the reason: a hand-maintained list of places
 * to look fell behind the first time somebody stored a URL in a new JSON
 * column, and fell behind silently — voice memos came back 100% unreferenced,
 * which is not a plausible fact about a working system, it is the shape of a
 * scan that cannot see. information_schema is the one source that cannot be out
 * of date with the schema, because it is the schema.
 *
 * Tier 1 is every table carrying its own storeId. Tier 2 is a table that
 * reaches a store through exactly ONE declared foreign key. Two paths to a
 * store is two possible owners, and picking between them is a guess.
 */
export async function deriveAttribution(db: RawQueryable, hosts: string[]): Promise<AttributionScan> {
  const stores = new Map<string, Set<string>>();
  const evidence = new Map<string, string>();
  const columnsSkipped: string[] = [];
  const tier2Joins: string[] = [];
  let columnsScanned = 0;

  if (hosts.length === 0) {
    return { stores, evidence, columnsScanned, columnsSkipped, tier1Tables: 0, tier2Joins };
  }

  // Anchored on the real hosts, so a supplier's CDN or somebody's website is
  // not collected as if it were ours.
  const alternation = hosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = `https?://(?:${alternation})/[^"'\\s\\\\)]+`;

  const record = (rows: { store: string | null; url: string }[], where: string) => {
    for (const row of rows) {
      if (!row.url) continue;
      const url = canonicalUrl(row.url);
      if (!evidence.has(url)) evidence.set(url, where);
      if (!row.store) continue;
      // A SET, not a list. One store referencing a blob from four columns is
      // one owner — not an ambiguity.
      let set = stores.get(url);
      if (!set) stores.set(url, (set = new Set()));
      set.add(row.store);
    }
  };

  const columns = await db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying', 'json', 'jsonb')
    ORDER BY table_name, column_name
  `);
  const byTable = new Map<string, string[]>();
  for (const c of columns) {
    const found = byTable.get(c.table_name) ?? [];
    found.push(c.column_name);
    byTable.set(c.table_name, found);
  }
  const hasStoreId = new Set(
    columns.filter((c) => c.column_name === "storeId").map((c) => c.table_name),
  );

  // ---- tier 1: the table owns a storeId --------------------------------
  for (const table of hasStoreId) {
    for (const column of byTable.get(table) ?? []) {
      if (column === "storeId") continue;
      const sql =
        `SELECT DISTINCT t."storeId" AS store, m[1] AS url ` +
        `FROM ${quoteIdent(table)} t, ` +
        `LATERAL regexp_matches(t.${quoteIdent(column)}::text, $1, 'g') AS m`;
      try {
        record(await db.$queryRawUnsafe(sql, pattern), `${table}.${column}`);
        columnsScanned++;
      } catch {
        // Skipped rather than guessed at, and REPORTED — a scan that quietly
        // examined less than it claimed is the bug this file exists to avoid.
        columnsSkipped.push(`${table}.${column}`);
      }
    }
  }

  // ---- tier 2: the table reaches a store through one foreign key --------
  const fks = await db.$queryRawUnsafe<
    { child: string; child_col: string; parent: string; parent_col: string }[]
  >(`
    SELECT tc.table_name AS child, kcu.column_name AS child_col,
           ccu.table_name AS parent, ccu.column_name AS parent_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);

  const reaching = new Map<string, typeof fks>();
  for (const fk of fks) {
    if (hasStoreId.has(fk.child)) continue; // tier 1 already covered it
    if (!hasStoreId.has(fk.parent)) continue;
    reaching.set(fk.child, [...(reaching.get(fk.child) ?? []), fk]);
  }

  for (const [child, candidates] of reaching) {
    // EXACTLY ONE, for the same reason the attribution rule itself has that
    // shape: two declared paths to a store is two possible owners.
    if (candidates.length !== 1) continue;
    const fk = candidates[0];
    tier2Joins.push(`${child} -> ${fk.parent}`);
    for (const column of byTable.get(child) ?? []) {
      const sql =
        `SELECT DISTINCT p."storeId" AS store, m[1] AS url ` +
        `FROM ${quoteIdent(child)} c ` +
        `JOIN ${quoteIdent(fk.parent)} p ON c.${quoteIdent(fk.child_col)} = p.${quoteIdent(fk.parent_col)}, ` +
        `LATERAL regexp_matches(c.${quoteIdent(column)}::text, $1, 'g') AS m`;
      try {
        record(await db.$queryRawUnsafe(sql, pattern), `${child}.${column} (via ${fk.parent})`);
        columnsScanned++;
      } catch {
        columnsSkipped.push(`${child}.${column}`);
      }
    }
  }

  return { stores, evidence, columnsScanned, columnsSkipped, tier1Tables: hasStoreId.size, tier2Joins };
}

/** The stores that reference a blob, filtered to those that still exist. */
export function candidatesFor(
  scan: AttributionScan,
  url: string,
  liveStoreIds: Set<string>,
): string[] {
  // A storeId that no longer names a store is not an attribution.
  return [...(scan.stores.get(canonicalUrl(url)) ?? [])].filter((id) => liveStoreIds.has(id));
}
