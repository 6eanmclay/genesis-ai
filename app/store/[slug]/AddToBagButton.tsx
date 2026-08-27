"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { addProductToBag } from "./bagActions";

// ADDING SOMETHING SHOULD FEEL LIKE SOMETHING HAPPENED.
//
// The form alone was silent: the action wrote a cookie, the page revalidated,
// the count at the top changed — and a customer looking at a product card
// halfway down a long storefront saw none of it. Adding a second item felt
// identical to adding nothing at all.
//
// So the button confirms in place. The floating bag carries the running total;
// this only has to answer "did that work", immediately, where they are looking.
//
// STILL A FORM POSTING A SERVER ACTION. The confirmation is presentation on top
// of the same submit — with JavaScript off, the button still adds to the bag,
// it just does not flash.

export function AddToBagButton({
  slug,
  productId,
  className,
}: {
  slug: string;
  productId: string;
  className: string;
}) {
  return (
    <form action={addProductToBag.bind(null, slug, productId)}>
      <AddButton className={className} />
    </form>
  );
}

function AddButton({ className }: { className: string }) {
  const { pending } = useFormStatus();
  const [confirmed, setConfirmed] = useState(false);
  // Whether a submit is genuinely in flight, so the confirmation fires on the
  // transition out of pending rather than on first render.
  const wasPending = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (pending) {
      wasPending.current = true;
      return;
    }
    if (!wasPending.current) return;
    wasPending.current = false;
    setConfirmed(true);
    if (timer.current) window.clearTimeout(timer.current);
    // Long enough to read, short enough that the button is ready for the next
    // product before they have finished scrolling to it.
    timer.current = window.setTimeout(() => setConfirmed(false), 2200);
  }, [pending]);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <button type="submit" disabled={pending} className={className}>
      {/* aria-live so the confirmation is announced, not just seen. */}
      <span aria-live="polite">
        {pending ? "Adding…" : confirmed ? "Added to Bag ✓" : "Add to Bag"}
      </span>
    </button>
  );
}
