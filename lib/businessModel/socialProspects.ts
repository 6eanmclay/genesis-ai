import { CONNECTOR_CATALOG } from "@/lib/integrations/catalog";
import { SOCIAL_PLATFORMS } from "@/lib/social/platforms";
import type { MapProspect } from "./mapEntities";

// WHICH PLATFORM IS WHICH, AND WHICH IS NONE OF THEM.
//
// ============ WHY THIS IS ITS OWN PURE FUNCTION (2026-09-02) ===========
//
// It was six lines inside BusinessMapSection, a server component, and it
// carried a defect that could not be tested where it lived:
//
//   CONNECTOR_CATALOG.find((e) => e.provider === platform.publishProvider)
//
// X's `publishProvider` is null — deliberately, because no connector exists
// for it — and several catalogue entries have `provider: null` for the same
// honest reason. So `null === null` matched, and X silently took the identity
// of the first such entry: Toast POS. X's card described a restaurant till.
//
// Nothing caught it because every assertion asked about X's connection STATE,
// which was correct ("Genesis cannot connect this yet"). The wrong thing was
// its description and its service id.
//
// ============ THE RULE =================================================
//
// Sean: "We should never allow two unrelated entities to match simply because
// both happen to have null identifiers. Matching needs to require an actual
// identifying value."
//
// So the absence of a provider is checked BEFORE the lookup, never inside the
// comparison. `lib/social/publisher.ts` already guards it this way; this is the
// one place in the codebase that did not.

export function socialProspects(connectedProviders: readonly string[]): MapProspect[] {
  const connected = new Set(connectedProviders);

  return SOCIAL_PLATFORMS.map((platform) => {
    const provider = platform.publishProvider;

    // NO IDENTIFYING VALUE, NO MATCH. Not `find(e => e.provider === provider)`
    // with a null provider — that is the bug this file exists to prevent.
    const entry = provider === null
      ? undefined
      : CONNECTOR_CATALOG.find((e) => e.provider === provider);

    return {
      id: platform.id,
      label: platform.label,
      // Connectable only when a connector actually exists for it.
      available: provider !== null && entry?.connector != null,
      connected: provider !== null && connected.has(provider),
      // THE PROVIDER'S OWN WORDS where the catalogue has them, and nothing at
      // all where it does not. No capability is written here.
      detail: entry?.description ?? "",
      serviceId: entry?.id ?? null,
    };
  });
}
