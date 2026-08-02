import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { withTenantIsolation } from "./tenantIsolation";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

// Every real call site in the app imports `prisma` from here, so applying
// the tenant-isolation guard once at this single choke point reaches all
// of them — no per-call-site changes needed. See lib/tenantIsolation.ts
// for what it actually guards and why. `$extends` shares the same
// underlying connection pool as the base client (confirmed against
// Prisma's own docs, not assumed) — exporting both below costs nothing
// extra.
function createClients() {
  const base = new PrismaClient({ adapter });
  return { base, guarded: withTenantIsolation(base) };
}

type PrismaClients = ReturnType<typeof createClients>;

const globalForPrisma = globalThis as unknown as {
  prismaClients: PrismaClients | undefined;
};

const clients = globalForPrisma.prismaClients ?? createClients();

export const prisma = clients.guarded;

// A small number of genuine cross-tenant SYSTEM operations legitimately
// can't be scoped to one storeId — e.g. the cron scheduler enumerating
// every store's due syncs, or a status endpoint checking every connected
// integration across the whole platform. That's not a gap the guard
// should catch; it's what a system-level job means. Use this ONLY for a
// call site that's reached exclusively via a CRON_SECRET-gated route (or
// equivalent) — never from a request carrying a specific user's session —
// and say so in a comment at that call site, the same way each one
// already does. Everywhere else, use `prisma`.
export const prismaSystem = clients.base;

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaClients = clients;
