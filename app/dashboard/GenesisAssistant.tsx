"use client";

import { useState } from "react";
import { SubmitButton } from "./SubmitButton";

type Message = {
  id: string;
  role: string;
  content: string;
  changes: unknown;
};

export function GenesisAssistant({
  storeName,
  messages,
  sendMessage,
}: {
  storeName: string;
  messages: Message[];
  sendMessage: (formData: FormData) => void;
}) {
  const [open, setOpen] = useState(messages.length > 0);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 rounded-full bg-foreground px-5 py-3 text-sm font-medium text-background shadow-xl transition-transform hover:scale-105"
      >
        ✨ Genesis
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex w-96 max-w-[calc(100vw-3rem)] flex-col rounded-2xl border border-black/[.08] bg-white shadow-xl dark:border-white/[.145] dark:bg-zinc-900">
      <div className="flex items-start justify-between border-b border-black/[.08] p-4 dark:border-white/[.145]">
        <div>
          <p className="font-semibold text-black dark:text-zinc-50">
            How can Genesis bring your vision to life?
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Your creative partner for {storeName}
          </p>
        </div>
        <button
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="text-zinc-400 hover:text-black dark:hover:text-zinc-50"
        >
          ✕
        </button>
      </div>

      <div className="flex max-h-80 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            <p className="font-medium text-black dark:text-zinc-50">
              Need help refining your store?
            </p>
            <p className="mt-1">
              Ask Genesis to improve your branding, design, products, or
              anything else.
            </p>
          </div>
        ) : (
          messages.map((m) => {
            const changes = m.changes as string[] | null;
            return (
              <div
                key={m.id}
                className={
                  m.role === "user"
                    ? "self-end rounded-lg bg-foreground px-3 py-2 text-sm text-background"
                    : "self-start rounded-lg border border-black/[.08] bg-zinc-50 px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-800 dark:text-zinc-50"
                }
              >
                <p>{m.content}</p>
                {changes && changes.length > 0 && (
                  <ul className="mt-2 list-disc pl-4 text-xs opacity-75">
                    {changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>

      <form
        action={sendMessage}
        className="flex flex-col gap-2 border-t border-black/[.08] p-4 dark:border-white/[.145]"
      >
        <textarea
          name="message"
          placeholder="Tell Genesis what you'd like to change…"
          rows={2}
          required
          className="rounded-lg border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
        <SubmitButton
          pendingText="Genesis is thinking..."
          className="self-start rounded-full bg-foreground px-4 py-1.5 text-sm text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          Ask Genesis
        </SubmitButton>
      </form>
    </div>
  );
}
