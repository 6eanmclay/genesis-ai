"use client";

// The third decision, made real (2026-08-14).
//
// Sean listed three interactions a proposal must offer: "Apply this / Not
// this / tell J4 what to change." The first two were buttons; the third was a
// sentence, which meant two of the three were controls and the most important
// one was a suggestion. The rebuttal is the whole product — it is what turns
// an approval card into a conversation — so it gets a control too.
//
// It does not open a second input. There is one composer, directly below the
// conversation this proposal is sitting in, and this simply puts the cursor
// there. Anything else would be a second place to talk to J4, which is
// exactly what "one conversation" rules out.
//
// Found by DOM query rather than a ref passed down through the tree: the
// proposal is server-rendered inside a server component, and threading a ref
// from the composer up through J4Surface and back down would mean making
// several components client-side purely to move a focus call. The composer's
// name attribute is a stable contract in the same file, and a missing
// textarea simply does nothing rather than erroring.
export function TellJ4Button({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        const field = document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
        if (!field) return;
        field.focus();
        // Bring it into view on a phone, where the proposal above it can be
        // tall enough that the composer is off screen.
        field.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }}
      className={className}
    >
      Tell J4 what to change
    </button>
  );
}
