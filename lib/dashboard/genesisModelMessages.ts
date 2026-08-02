// Shared between lib/genesisModel.ts (server-only — it instantiates a real
// Anthropic client at module scope, so nothing in that file is safe to
// import from a Client Component) and GenesisAssistant.tsx (client, which
// needs to detect this exact message to render the "Continue anyway"
// button). Lives here instead, in a file with zero server-only imports, so
// both sides read from one real source instead of two copies drifting.
export const USAGE_CEILING_MESSAGE =
  "Genesis has reached today's AI safety limit for this store — a protective measure against unexpected usage, not a sign anything is wrong. It resets automatically. Your message has been saved — please try again shortly.";
