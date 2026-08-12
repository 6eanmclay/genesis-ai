// J4's typographic voice (2026-08-12) — from the "Workshop and the Light"
// visual language: Genesis is the workshop, J4 is the intelligence working in
// it, and a merchant shouldn't have to work out which voice is which. Giving
// J4 a serif makes that distinction pre-verbal.
//
// Deliberately narrow. This is NOT an editorial redesign of the product —
// Sean's explicit correction: "don't turn the entire product into an
// editorial/serif interface. Business UI should remain clean and highly
// functional; J4 can have a subtle serif/editorial treatment so the
// distinction is felt immediately."
//
// So the rule is: apply this ONLY to prose J4 himself authored — his briefing
// sentence, his observations, his replies. Never to labels, numbers, buttons,
// navigation, product names, money, or any chrome. If you can't point at the
// sentence J4 wrote, it doesn't get this class.
//
// A plain string constant, like GENESIS_AVATAR_SIZE and GENESIS_ATMOSPHERE —
// Tailwind's build-time scanner reads this file the same as any other, so the
// class really does generate CSS.
export const J4_VOICE = "font-serif";
