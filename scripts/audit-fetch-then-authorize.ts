import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// WHERE A LOOKUP IS MISTAKEN FOR AN AUTHORIZATION DECISION:
//
//   npx tsx scripts/audit-fetch-then-authorize.ts
//
// ============ THE DEFECT THIS LOOKS FOR ================================
//
// A caller supplies an id. The code fetches the record, the fetch succeeds, and
// the code proceeds — as though a row coming back were proof the caller was
// entitled to it. It is not. `findUnique({ where: { id } })` returns any row in
// the table, whoever it belongs to.
//
// The subtler half, and the one that survives review: the function DOES
// authorize. It calls requireBusiness and gets a real storeId. Then it acts on
// a record it looked up by a caller-supplied id without scoping that lookup to
// the storeId it just established. The authorization is real, thorough, and
// attached to the wrong resource — a correct answer to a question nobody asked.
//
// ============ HOW IT DECIDES WHAT IS SCOPED ============================
//
// The store-scoped models are read out of schema.prisma — every model with a
// `storeId` column — rather than listed here. A model added next month is
// covered without anybody remembering to add it, which is the same rule
// ARCHITECTURE.md applies to every registry that mirrors something else.
//
// This is an AUDIT, not a test. It reports candidates for a human to judge.
// A query with no storeId can be perfectly correct — a global admin read, a
// lookup that is itself the ownership check, a webhook resolving a store from a
// provider id. The output is a list to think about, not a list of bugs.

const ROOT = process.cwd();
const OPS = [
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "update", "updateMany", "delete", "deleteMany", "upsert", "count", "aggregate",
];

/** Models with a storeId column, read from the schema. */
function storeScopedModels(): Set<string> {
  const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
  const out = new Set<string>();
  for (const match of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    if (/^\s+storeId\s/m.test(match[2])) {
      // Prisma exposes the model camel-cased on the client.
      out.add(match[1][0].toLowerCase() + match[1].slice(1));
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** Strip comments so prose about `storeId` never counts as a scoped query. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The balanced `(...)` starting at an open paren. */
function balanced(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open, Math.min(open + 600, source.length));
}

/** The `where: {...}` object inside a call's arguments. */
function whereClause(args: string): string | null {
  const at = args.indexOf("where:");
  if (at === -1) return null;
  const brace = args.indexOf("{", at);
  if (brace === -1) return null;
  return balanced(args, brace);
}

export interface Finding {
  file: string;
  line: number;
  model: string;
  op: string;
  where: string;
  /** True when the enclosing function establishes a business first. */
  authorizedNearby: boolean;
}

const AUTHORIZERS =
  /requireBusiness|requireStorePermission|requireStorePageAccess|resolveUserStore|requireBusinessOrActive|requireBusinessPage/;

export function audit(): { findings: Finding[]; scanned: number; scoped: number } {
  const scoped = storeScopedModels();
  const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))];
  const findings: Finding[] = [];

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const source = codeOnly(raw);
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");

    const call = new RegExp(
      `(?:prisma|prismaSystem|tx|client|db)\\.(\\w+)\\.(${OPS.join("|")})\\s*\\(`,
      "g",
    );
    for (const match of source.matchAll(call)) {
      const [, model, op] = match;
      if (!scoped.has(model)) continue;

      const args = balanced(source, match.index! + match[0].length - 1);
      const where = whereClause(args);
      // No `where` at all: a findMany over an entire store-scoped table, which
      // is its own question, and a `create` is not in OPS.
      const text = where ?? "(no where clause)";

      // Scoped if the filter names the business in any of the shapes used here.
      const isScoped =
        /\bstoreId\b/.test(text) ||
        /\bstore:\s*\{/.test(text) ||
        /\bstore:\s*\{[\s\S]*userId/.test(text);
      if (isScoped) continue;

      // A filter with no caller-supplied value cannot be steered by one.
      const referencesAVariable = /\b(?:id|Id|slug|key|token|externalId)\b/.test(text);
      if (!referencesAVariable) continue;

      const line = source.slice(0, match.index!).split("\n").length;
      // Look back for an authorization call in the preceding 80 lines — a crude
      // stand-in for "the enclosing function", and deliberately generous: a
      // false "authorized nearby" makes the finding look LESS urgent, so the
      // error runs toward reporting rather than away from it.
      const before = source.slice(Math.max(0, match.index! - 4000), match.index!);
      findings.push({
        file: rel, line, model, op,
        where: text.replace(/\s+/g, " ").slice(0, 120),
        authorizedNearby: AUTHORIZERS.test(before),
      });
    }
  }

  return { findings, scanned: files.length, scoped: scoped.size };
}

if (process.argv[1]?.includes("audit-fetch-then-authorize")) {
  const { findings, scanned, scoped } = audit();
  console.log(`\nScanned ${scanned} files against ${scoped} store-scoped models.\n`);

  const authorized = findings.filter((f) => f.authorizedNearby);
  const bare = findings.filter((f) => !f.authorizedNearby);

  console.log(`=== ${authorized.length} queries in code that DOES authorize, but not on this resource ===\n`);
  for (const f of authorized) {
    console.log(`  ${f.file}:${f.line}  ${f.model}.${f.op}  ${f.where}`);
  }
  console.log(`\n=== ${bare.length} queries with no authorization call nearby ===\n`);
  for (const f of bare) {
    console.log(`  ${f.file}:${f.line}  ${f.model}.${f.op}  ${f.where}`);
  }
  console.log(`\n${findings.length} candidates for review.\n`);
}
