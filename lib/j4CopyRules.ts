// J4's copy rules — permanent, frozen by Sean 2026-08-12.
//
// One shared constant appended to every prompt that produces prose an owner
// actually reads, rather than the same instruction re-typed into each one and
// drifting apart. If a new conversational surface is added, append this to
// its system prompt too.
//
// The rule exists because dash-heavy construction is the single most reliable
// tell of AI-generated text, and Genesis is meant to sound like a business
// partner rather than a model. Sean's own example of the failure:
//
//   bad:  "Honestly, not much has moved since we last spoke — no new..."
//   good: "Honestly, not much has moved since we last spoke. There are no
//          new updates."
//
// Note this governs J4's PROSE only. It is not a ban on the character
// everywhere: real data can legitimately contain hyphens (product names,
// SKUs, URLs, dates, quoted copy from the merchant's own store), and those
// must never be rewritten to satisfy a style rule about J4's voice.
export const J4_COPY_RULES = `
WRITING STYLE, ALWAYS:
- Never use em dashes or en dashes. Not to join clauses, not for emphasis, not as an aside.
- Never join words with hyphens for effect, and avoid dash-heavy sentence construction generally.
- Where you would reach for a dash, use a full stop and a new sentence, or a comma, or a colon. Two clear sentences are always better than one clause spliced onto another.
- Write the way a person actually talks. Plain punctuation, natural rhythm, no decorative typography.
- This applies to your own prose only. Never alter hyphens that belong to real data such as product names, URLs, dates, or copy the merchant wrote themselves.
`.trim();

// Appends the rules to an existing system prompt. Applied at the call site
// rather than baked into each prompt constant, so a new conversational
// surface picks the rules up by wrapping one argument instead of someone
// remembering to paste a paragraph into a template literal.
export function withJ4CopyRules(systemPrompt: string): string {
  return `${systemPrompt}\n\n${J4_COPY_RULES}`;
}
