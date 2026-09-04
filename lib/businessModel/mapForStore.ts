import { prisma } from "@/lib/prisma";
import { businessMap, type BusinessMap } from "./businessMap";
import { readOwnerFactsWithProvenance } from "./ownerFacts";
import type { BusinessUnderstanding } from "./understanding";

// ONE PLACE DECIDES WHAT THE MAP IS BUILT FROM (2026-09-03, P2).
//
// `businessMap()` is pure and takes its inputs; until now the only caller that
// assembled those inputs was the section that renders it. P2 adds a second
// reader — resolving the nodes an owner has SELECTED, so J4 can be told what
// they are looking at — and two independent assemblies of the same map is
// exactly the mirrored-registry problem: the one that drifted would be the one
// nobody read, and a selection would resolve against a map subtly unlike the
// one on screen.
//
// Sean's standing rule for the map is "do not create a second Business
// Understanding model, do not create new persistence for the derived map".
// This creates neither. It fetches the same inputs the section already
// fetched, calls the same pure assembler, stores nothing and caches nothing.
//
// `productImages` and the observation overlay stay with the section: they are
// presentation, and nothing about resolving a selection needs a photograph.
export async function mapForStore(
  storeId: string,
  understanding: BusinessUnderstanding,
  options: { slug?: string | null; productImages?: Record<string, string> } = {},
): Promise<BusinessMap> {
  const [facts, designCount] = await Promise.all([
    readOwnerFactsWithProvenance(storeId),
    // Designs are not in the profile, so they are counted rather than invented
    // inside the assembler — the same reason the section counts them.
    prisma.businessRecord.count({ where: { storeId, entityType: "design" } }),
  ]);

  return businessMap({
    understanding,
    facts,
    slug: options.slug ?? null,
    designCount,
    productImages: options.productImages ?? {},
  });
}
