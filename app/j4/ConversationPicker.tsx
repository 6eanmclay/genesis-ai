"use client";

import { useState } from "react";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { startConversation } from "./conversation-actions";

// THE OWNER'S OWN LIST OF CONVERSATIONS (UI6 piece 2).
//
// A conversation is not a feature if the owner cannot start one, see the ones
// they have, or return to one — so this is part of piece 2 rather than
// something the context pane brings later.
//
// DELIBERATELY THIN, matching the contract. There is no rename, no close, no
// archive and no delete, because none of those was decided; a row that could
// hold a closedAt is not a reason to build closing. What is here is exactly
// create, list, and select.
//
// "Everything else" is not a conversation and is not styled as one. It is where
// every message written before conversations existed lives — a null
// conversationId means no conversation was recorded, never a manufactured one —
// and the owner needs somewhere to read those.

export interface ConversationOption {
  id: string;
  name: string | null;
  messageCount: number;
  lastMessageAt: string | null;
}

export function ConversationPicker({
  conversations,
  selectedId,
  onSelect,
  slug,
}: {
  conversations: ConversationOption[];
  /** Null means the ungrouped history, which is not a conversation. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  slug?: string;
}) {
  const [starting, setStarting] = useState(false);
  const [name, setName] = useState("");

  const label = (c: ConversationOption) =>
    // A name is optional, so an unnamed conversation is described by what it is
    // rather than given an invented title. Nothing generates a name.
    c.name ?? (c.messageCount === 0 ? "New conversation" : `${c.messageCount} messages`);

  return (
    <div className="flex flex-col gap-2" data-role="conversation-picker">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
          Conversations
        </span>
        <button
          type="button"
          data-role="start-conversation"
          onClick={() => setStarting((v) => !v)}
          className="rounded-full border px-2.5 py-1 text-[11px] font-medium text-[#f4f2fb] transition hover:bg-white/[.06]"
          style={{ borderColor: GENESIS_ATMOSPHERE.violet }}
        >
          {starting ? "Cancel" : "New"}
        </button>
      </div>

      {starting && (
        // The name is the owner's, and optional — submitting it empty is a real
        // choice rather than an incomplete form.
        <form
          action={async (formData: FormData) => {
            await startConversation(slug, formData);
            setStarting(false);
            setName("");
          }}
          className="flex gap-1.5"
        >
          <input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name it, or leave blank"
            className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs text-[#f4f2fb] placeholder:text-white/30"
            style={{ borderColor: GENESIS_ATMOSPHERE.border }}
          />
          <button
            type="submit"
            className="rounded-md border px-2 py-1 text-[11px] text-[#f4f2fb]"
            style={{ borderColor: GENESIS_ATMOSPHERE.violet }}
          >
            Start
          </button>
        </form>
      )}

      <ul className="flex flex-col gap-0.5">
        {conversations.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              data-role="select-conversation"
              data-conversation-id={c.id}
              onClick={() => onSelect(c.id)}
              aria-current={selectedId === c.id ? "true" : undefined}
              className="w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-white/[.06]"
              style={{
                color: selectedId === c.id ? "#f4f2fb" : GENESIS_ATMOSPHERE.textSecondary,
                backgroundColor: selectedId === c.id ? "rgba(255,255,255,.06)" : undefined,
              }}
            >
              {label(c)}
            </button>
          </li>
        ))}

        {/* Not a conversation, and not presented as one. */}
        <li>
          <button
            type="button"
            data-role="select-ungrouped"
            onClick={() => onSelect(null)}
            aria-current={selectedId === null ? "true" : undefined}
            className="w-full rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-white/[.06]"
            style={{
              color: selectedId === null ? "#f4f2fb" : GENESIS_ATMOSPHERE.textSecondary,
              backgroundColor: selectedId === null ? "rgba(255,255,255,.06)" : undefined,
            }}
          >
            Everything else
          </button>
        </li>
      </ul>
    </div>
  );
}
