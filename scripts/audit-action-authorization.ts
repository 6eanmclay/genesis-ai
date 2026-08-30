import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// EVERY SERVER ACTION, AND WHETHER IT AUTHORIZES ITSELF.
//
//   npx tsx scripts/audit-action-authorization.ts
//
// ============ WHY THIS EXISTS (2026-08-30) =============================
//
// Item 8 established the rule the hard way: a server action is a POST endpoint
// with a generated id, and a layout gate does not protect it. That was proven
// for ONE action. This asks the same question of every other one.
//
// It reports rather than judges. An action with no guard is not automatically
// a hole — a public storefront action is meant to be callable by anybody, and
// a helper may guard on the action's behalf. What it produces is the list a
// person then has to look at, which is exactly what nobody has had.

const GUARDS = [
  "requireStorePermission", "requireBusiness", "requireBusinessPage",
  "requireBusinessOrActive", "requireBusinessPageOrActive", "requireStorePageAccess",
  "requirePlatformAdmin", "assertPlatformAdmin", "isPlatformAdmin",
  "auth()", "getStoreRole", "resolveUserStore", "approvalAccessibleTo",
];

const files = execSync('git ls-files "app/**/*.ts" "app/**/*.tsx" "lib/**/*.ts"', { encoding: "utf8" })
  .split("\n").filter(Boolean)
  // THE DIRECTIVE, NOT THE PHRASE. A first pass matched the string anywhere and
  // pulled in six lib/ modules that only MENTION "use server" in a comment
  // explaining why they are not one — which would have had me auditing the
  // authorization of functions that are not endpoints at all.
  .filter((f) => {
    const head = readFileSync(f, "utf8").replace(/^﻿/, "").trimStart();
    return head.startsWith('"use server"') || head.startsWith("'use server'");
  });

interface Row { file: string; fn: string; guard: string | null; delegatesTo: string[] }
const rows: Row[] = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  // Split on exported async functions; each slice is one action's body.
  const parts = src.split(/^export async function /m);
  for (const part of parts.slice(1)) {
    const fn = part.slice(0, part.indexOf("(")).trim();
    const body = part;
    const guard = GUARDS.find((g) => body.includes(g)) ?? null;
    // What it calls, so an unguarded action can be traced to whatever guards
    // on its behalf rather than being reported as a hole on sight.
    const calls = [...body.matchAll(/await ([a-zA-Z][\w.]*)\(/g)]
      .map((m) => m[1])
      .filter((c) => !GUARDS.includes(c) && !["Promise.all", "prisma", "revalidatePath"].includes(c));
    rows.push({ file, fn, guard, delegatesTo: [...new Set(calls)].slice(0, 4) });
  }
}

const guarded = rows.filter((r) => r.guard);
const unguarded = rows.filter((r) => !r.guard);

console.log(`\n${rows.length} exported server actions across ${files.length} files.`);
console.log(`${guarded.length} call an authorization helper directly.`);
console.log(`${unguarded.length} do not — each needs a human decision.\n`);

console.log("--- no direct authorization call ---\n");
const byFile = new Map<string, Row[]>();
for (const r of unguarded) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
for (const [file, rs] of [...byFile].sort()) {
  console.log(file);
  for (const r of rs) console.log(`    ${r.fn}  →  ${r.delegatesTo.join(", ") || "(no awaited calls)"}`);
  console.log();
}

console.log("--- guard used, by name ---\n");
const tally = new Map<string, number>();
for (const r of guarded) tally.set(r.guard!, (tally.get(r.guard!) ?? 0) + 1);
for (const [g, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${g}`);
console.log();
