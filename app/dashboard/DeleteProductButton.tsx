"use client";

import { useFormStatus } from "react-dom";

export function DeleteProductButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (!confirm("Delete this product? This cannot be undone.")) {
          e.preventDefault();
        }
      }}
      className="text-xs text-red-600 underline hover:text-red-800 disabled:opacity-50"
    >
      {pending ? "Deleting..." : "Delete"}
    </button>
  );
}
