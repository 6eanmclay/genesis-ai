import { prisma } from "@/lib/prisma";
import { resolveBusiness } from "@/lib/businessContext";

// WHAT THE PHONE DOES WITH A TURN THE WEBSITE WOULD HAND ON (MOBILE_CHAT_CONTRACT.md D4).
//
// streamChatTurn emits `fallback` for two kinds of turn, and the website answers
// both by re-sending the message to a Server Action the phone cannot call. So
// the phone's route passes the turn's stream through this, which rewrites only
// those events and drops the ones that steer a browser:
//
//   fallback + edit_store_content   a storefront edit. Both sides are SAVED to
//                                   the main thread with J4 saying where it will
//                                   be finished, so it is waiting on the
//                                   dashboard rather than lost.
//   fallback, anything else         J4 could not answer. An `error` the phone
//                                   shows, and NOTHING saved — the turn wrote
//                                   nothing before falling back, and a question
//                                   with no answer must not enter the history.
//   navigate, focus, padding        website-only. Dropped.
//
// Everything else — status lines, words, done, error — passes through as sent.

export const STOREFRONT_EDIT_REPLY =
  "That's a change to your storefront, and I'll want you to see it before it goes live. Send it to me from Genesis on the web and I'll draft it there.";

export const COULD_NOT_ANSWER = "I couldn't answer that just now — try again.";

type Event = { type: string; [key: string]: unknown };

/**
 * Rewrite a streamChatTurn stream for the phone.
 *
 * `onStorefrontEdit` saves the deferred edit and receives what J4 had already
 * said this turn, so what is saved matches what the owner read.
 */
export function adaptTurnForPhone(
  upstream: ReadableStream<Uint8Array>,
  onStorefrontEdit: (alreadySaid: string) => Promise<void>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let said = "";

  const send = (controller: TransformStreamDefaultController<Uint8Array>, event: Event) =>
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

  const handle = async (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!line.trim()) return;
    let event: Event;
    try {
      event = JSON.parse(line) as Event;
    } catch {
      return;
    }

    if (event.type === "padding" || event.type === "navigate" || event.type === "focus") return;

    if (event.type === "token" && typeof event.delta === "string") said += event.delta;

    if (event.type === "fallback") {
      if (event.reason === "edit_store_content") {
        const delta = said ? `\n\n${STOREFRONT_EDIT_REPLY}` : STOREFRONT_EDIT_REPLY;
        await onStorefrontEdit(said);
        said += delta;
        send(controller, { type: "token", delta });
        send(controller, { type: "done", changes: null });
      } else {
        send(controller, { type: "error", message: COULD_NOT_ANSWER });
      }
      return;
    }

    send(controller, event);
  };

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          await handle(line, controller);
        }
      },
      async flush(controller) {
        buffer += decoder.decode();
        if (buffer) await handle(buffer, controller);
      },
    })
  );
}

/**
 * Save a storefront edit the phone handed back: the owner's words and J4's
 * reply, in the main thread of the business the turn was about.
 *
 * Resolved the way the turn resolved it — the account's business with no slug,
 * because the phone never sends one — so it lands where the turn read from.
 */
export async function saveDeferredStorefrontEdit(input: {
  userId: string;
  userMessage: string;
  alreadySaid: string;
}): Promise<void> {
  const resolution = await resolveBusiness(input.userId);
  if (resolution.kind !== "resolved") return;
  const reply = input.alreadySaid ? `${input.alreadySaid}\n\n${STOREFRONT_EDIT_REPLY}` : STOREFRONT_EDIT_REPLY;
  await prisma.storeMessage.create({
    data: { storeId: resolution.store.id, role: "user", content: input.userMessage, conversationId: null },
  });
  await prisma.storeMessage.create({
    data: { storeId: resolution.store.id, role: "assistant", content: reply, conversationId: null },
  });
}
