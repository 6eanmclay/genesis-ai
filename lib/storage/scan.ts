import "server-only";

import { prismaSystem } from "@/lib/prisma";

// EVERY REFERENCE, FROM EVERY COLUMN, WITHOUT A LIST.
//
// ============ THE LIST FELL BEHIND IMMEDIATELY (2026-08-28) =============
//
// lib/storage/references.ts opens by warning that "a reference check listing
// known field names would fall behind the first time somebody stored a URL
// somewhere new, and would fall behind silently." The first report built on it
// did exactly that. It scanned five tables, and the schema has more than forty
// JSON columns.
//
// The gap showed itself honestly, which is the only reason it was caught:
// voice-memos/ and voice-turns/ came back 100% unreferenced, thirty-three files
// and not one reference. A whole category being orphaned is not a plausible
// fact about a working system, it is the shape of a scan that cannot see. And
// it could not: uploadVoiceMemo records the audio on StoreMessage.changes,
// a JSON column the scan never read. Deleting on that report would have
// silently stripped the audio out of the owner's conversation history.
//
// Store.creativeDirection, StoreDraft.productsDraft, StoreGeneration
// .generatedOutput, ExecutionLog.metadata, Task.context and ApprovalRequest
// .input can all hold image URLs too. Enumerating them by hand would fix
// today's gap and rebuild the same trap for whoever adds the next column.
//
// ============ SO IT ASKS THE DATABASE WHAT ITS COLUMNS ARE =============
//
// information_schema is the one source that cannot be out of date with the
// schema, because it IS the schema. Every text-ish and JSON column in the
// public schema is swept for stored URLs, so a column added next month is
// covered the day it exists, by nobody remembering anything.
//
// It is slower than five targeted queries. It is run by an operator looking at
// a storage report, not on a page load, and the alternative is a number that
// is wrong in the direction that deletes a live product's photograph.

/** A column worth searching: it can hold text, so it can hold a URL. */
interface ScannableColumn {
  table: string;
  column: string;
}

/**
 * Every column in the database that could contain a URL.
 *
 * Deliberately generous. A `character varying` that has never held a URL costs
 * one scan of a column that returns nothing; a column skipped because it looked
 * unlikely is the voice-memo bug again.
 */
async function scannableColumns(): Promise<ScannableColumn[]> {
  const rows = await prismaSystem.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying', 'json', 'jsonb')
    ORDER BY table_name, column_name
  `;
  return rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

/** Double-quote an identifier, refusing anything that is not one. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to build a query around an unexpected identifier: ${name}`);
  }
  return `"${name}"`;
}

export interface ReferenceHit {
  url: string;
  /** "StoreMessage.changes" — enough to go and look. */
  source: string;
}

/**
 * Find every stored URL referenced anywhere in the database.
 *
 * `hosts` comes from the storage listing itself rather than being configured,
 * so this follows the provider without being told about it.
 */
export async function scanAllReferences(hosts: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (hosts.length === 0) return found;

  // Anchored on the real hosts, so a URL to a supplier's CDN or somebody's
  // website is not collected as if it were ours.
  const hostAlternation = hosts
    .map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = `https?://(?:${hostAlternation})/[^"'\\s\\\\)]+`;

  for (const { table, column } of await scannableColumns()) {
    let sql: string;
    try {
      sql =
        `SELECT DISTINCT m[1] AS url FROM ${quoteIdent(table)}, ` +
        `LATERAL regexp_matches(${quoteIdent(column)}::text, $1, 'g') AS m`;
    } catch {
      // An identifier this file will not interpolate. Skipped rather than
      // guessed at — and there are none in this schema today.
      continue;
    }

    try {
      const rows = await prismaSystem.$queryRawUnsafe<{ url: string }[]>(sql, pattern);
      for (const row of rows) {
        if (!row.url) continue;
        // First finder wins: a report needs to say THAT something is referenced
        // and give one place to look, not enumerate every row that mentions it.
        if (!found.has(row.url)) found.set(row.url, `${table}.${column}`);
      }
    } catch {
      // A column the cast cannot handle is skipped rather than failing the whole
      // sweep. It is reported as a note by the caller, because a scan that
      // quietly examined less than it claimed is the bug this file exists to fix.
      continue;
    }
  }

  return found;
}

/** The distinct hosts a set of URLs live on. */
export function hostsOf(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).host);
    } catch {
      // Not a URL. Nothing to learn from it.
    }
  }
  return [...hosts];
}
