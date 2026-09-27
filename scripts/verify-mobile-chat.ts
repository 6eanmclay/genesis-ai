// THE MODEL, POINTED AT NOTHING. Set before anything imports lib/genesisModel,
// which builds its client at module load. A port that refuses connections makes
// every model call fail the way a provider outage does — which is exactly the
// turn D4 says the phone must answer with "try again" and must not save. No real
// request leaves this machine and no key is needed.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key-not-used";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";

import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { issueMobileSession, hashMobileKey } from "@/lib/auth/mobileSession";
import { checkRateLimit } from "@/lib/http/rateLimit";
import {
  adaptTurnForPhone,
  saveDeferredStorefrontEdit,
  STOREFRONT_EDIT_REPLY,
  COULD_NOT_ANSWER,
} from "@/lib/j4/phoneChat";
import { POST as phoneChat } from "@/app/api/mobile/v1/chat/route";
import { GET as phoneMessages } from "@/app/api/mobile/v1/messages/route";

// TALKING TO J4 ON THE PHONE:
//
//   npx tsx scripts/run-db-suites.ts mobile-chat
//
// MOBILE_CHAT_CONTRACT.md, approved 2026-09-27. What this proves:
//
//   the phone reads and writes the dashboard's own J4 thread, and only its own
//     business's — never a named conversation, never another account's
//   a dead key is refused before any work is done
//   the hourly limit is ONE allowance shared with the website
//   D4: a storefront edit is saved with J4 saying where it will be finished; a
//     turn J4 could not answer is an error the phone shows and is NOT saved
//   the website-only events (padding, navigate, focus) never reach the phone
//
// The J4 turn itself is the website's (lib/j4/chatTurn.ts) and is not re-tested
// here; its own suites cover it.

const results: { name: string; ok: boolean }[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const rand = () => Math.random().toString(36).slice(2, 8);
const PHONE_AGENT = "J4/1.0.0 (iPhone; ios 26.5)";

/** A stream that delivers these bytes in these exact chunks — lines split across chunks on purpose. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function eventsOf(stream: ReadableStream<Uint8Array>): Promise<{ type: string; [k: string]: unknown }[]> {
  const text = await new Response(stream).text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function chatRequest(key: string | null, body: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": PHONE_AGENT };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Request("http://localhost/api/mobile/v1/chat", { method: "POST", headers, body: JSON.stringify(body) });
}

function messagesRequest(key: string): Request {
  return new Request("http://localhost/api/mobile/v1/messages", {
    headers: { authorization: `Bearer ${key}`, "user-agent": PHONE_AGENT },
  });
}

async function makeOwner(label: string) {
  const user = await prisma.user.create({ data: { email: `chat-${label}-${rand()}@test.local`, name: label } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: `${label}'s Shop`, slug: `chat-${label.toLowerCase()}-${rand()}`, tagline: "t", description: "d", published: true },
  });
  await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: store.id } });
  const { key } = await issueMobileSession({ userId: user.id, device: "iPhone · J4" });
  return { user, store, key };
}

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await makeOwner("Owner");
  const stranger = await makeOwner("Stranger");

  try {
    // ========================================================================
    console.log("\n=== 1. The phone sees the J4 conversation, not the website's plumbing ===\n");
    // ========================================================================
    const passthrough = await eventsOf(
      adaptTurnForPhone(
        streamOf([
          `{"type":"padding","data":"      "}\n{"type":"status","text":"Working`,
          ` on your request…"}\n{"type":"token","delta":"Sales were "}\n{"type":"tok`,
          `en","delta":"up."}\n{"type":"navigate","href":"/b/x/analytics"}\n{"type":"focus","nodeIds":["n1"]}\n`,
          `{"type":"done","changes":null}`,
        ]),
        async () => {
          throw new Error("not a storefront edit");
        }
      )
    );
    check(
      "status, words and done arrive intact, even split across chunks",
      passthrough.map((e) => e.type),
      ["status", "token", "token", "done"]
    );
    check("and the words are whole", passthrough.filter((e) => e.type === "token").map((e) => e.delta).join(""), "Sales were up.");
    assert("padding, navigate and focus are website-only and never reach the phone",
      !passthrough.some((e) => ["padding", "navigate", "focus"].includes(e.type)));

    // ========================================================================
    console.log("\n=== 2. D4 — a storefront edit is kept, with J4 saying where it's finished ===\n");
    // ========================================================================
    let handedOver: string | null = null;
    const edit = await eventsOf(
      adaptTurnForPhone(
        streamOf([`{"type":"status","text":"Working…"}\n{"type":"token","delta":"On it."}\n{"type":"fallback","reason":"edit_store_content"}\n`]),
        async (alreadySaid) => {
          handedOver = alreadySaid;
        }
      )
    );
    check("what J4 had already said is handed over to be saved", handedOver, "On it.");
    check("the phone hears where the edit will be finished", edit.filter((e) => e.type === "token").map((e) => e.delta).join(""),
      `On it.\n\n${STOREFRONT_EDIT_REPLY}`);
    check("and the turn ends normally", edit.at(-1)?.type, "done");
    assert("no fallback event reaches the phone, which has nowhere to send it", !edit.some((e) => e.type === "fallback"));

    await saveDeferredStorefrontEdit({ userId: owner.user.id, userMessage: "Change my headline to Hand-wound copper", alreadySaid: "On it." });
    const savedEdit = await prisma.storeMessage.findMany({ where: { storeId: owner.store.id }, orderBy: { createdAt: "asc" } });
    check("both sides are saved to the owner's business", savedEdit.map((m) => m.role), ["user", "assistant"]);
    check("the owner's words, as sent", savedEdit[0]?.content, "Change my headline to Hand-wound copper");
    check("and exactly what the phone showed", savedEdit[1]?.content, `On it.\n\n${STOREFRONT_EDIT_REPLY}`);
    assert("in the main thread the dashboard opens on", savedEdit.every((m) => m.conversationId === null));

    // ========================================================================
    console.log("\n=== 3. D4 — a turn J4 could not answer is said, and not saved ===\n");
    // ========================================================================
    let editCalled = false;
    const unresolved = await eventsOf(
      adaptTurnForPhone(streamOf([`{"type":"status","text":"Working…"}\n{"type":"fallback"}\n`]), async () => {
        editCalled = true;
      })
    );
    check("the phone is told to try again", unresolved.at(-1), { type: "error", message: COULD_NOT_ANSWER });
    check("and nothing is handed over to be saved", editCalled, false);

    // ========================================================================
    console.log("\n=== 4. Through the real route: who may talk to J4 ===\n");
    // ========================================================================
    check("no key is signed out", (await phoneChat(chatRequest(null, { message: "hi" }))).status, 401);
    const revoked = await issueMobileSession({ userId: owner.user.id, device: "iPhone · J4" });
    await prisma.userSession.update({ where: { tokenHash: hashMobileKey(revoked.key) }, data: { revokedAt: new Date() } });
    const before = await prisma.storeMessage.count({ where: { storeId: owner.store.id } });
    check("an ended session is signed out", (await phoneChat(chatRequest(revoked.key, { message: "hi" }))).status, 401);
    check("and nothing was written for it", await prisma.storeMessage.count({ where: { storeId: owner.store.id } }), before);
    check("a body with no message is refused before J4 is asked", (await phoneChat(chatRequest(owner.key, {}))).status, 400);
    check("J4's own length rule still applies", (await phoneChat(chatRequest(owner.key, { message: "x".repeat(8001) }))).status, 413);

    // ========================================================================
    console.log("\n=== 5. Through the real route: J4 unreachable, end to end ===\n");
    // ========================================================================
    const beforeTurn = await prisma.storeMessage.count({ where: { storeId: owner.store.id } });
    const response = await phoneChat(chatRequest(owner.key, { message: "What sold this week?", requestId: "verify-mobile-chat" }));
    check("the turn streams", [response.status, response.headers.get("content-type")], [200, "application/x-ndjson"]);
    const turn = await eventsOf(response.body!);
    assert("J4's own status line reaches the phone", turn.some((e) => e.type === "status"), turn.map((e) => e.type).join(","));
    check("and a model outage ends as the phone's 'try again'", turn.at(-1), { type: "error", message: COULD_NOT_ANSWER });
    assert("with no padding, which only Safari needed", !turn.some((e) => e.type === "padding"));
    check("and the history holds no question without an answer",
      await prisma.storeMessage.count({ where: { storeId: owner.store.id } }), beforeTurn);

    // ========================================================================
    console.log("\n=== 6. One account, one hourly allowance ===\n");
    // ========================================================================
    // Exactly what the website's route charges per message, spent as though
    // from the browser.
    for (let i = 0; i < 120; i++) {
      await checkRateLimit([{ kind: "chat:user", value: stranger.user.id, max: 120, windowMs: 60 * 60 * 1000 }], {
        surface: "chat",
        actorId: stranger.user.id,
      });
    }
    check("after the website has used the hour's messages, the phone is refused too",
      (await phoneChat(chatRequest(stranger.key, { message: "hello" }))).status, 429);

    // ========================================================================
    console.log("\n=== 7. The thread the phone reads is the dashboard's, and only this business's ===\n");
    // ========================================================================
    const named = await prisma.conversation.create({ data: { storeId: owner.store.id, name: "Holiday plan" } });
    await prisma.storeMessage.create({ data: { storeId: owner.store.id, role: "user", content: "Filed in a named conversation", conversationId: named.id } });
    await prisma.storeMessage.create({ data: { storeId: owner.store.id, role: "user", content: "A memo from the website", changes: { audioUrl: "https://example.test/memo.m4a" } } });
    await prisma.storeMessage.create({ data: { storeId: stranger.store.id, role: "user", content: "The stranger's own business" } });

    const read = await phoneMessages(messagesRequest(owner.key));
    check("the phone can read its thread", read.status, 200);
    const thread = (await read.json()).messages as { role: string; content: string; voiceMemo: boolean }[];
    check("oldest first, as a conversation reads",
      thread.map((m) => m.content),
      ["Change my headline to Hand-wound copper", `On it.\n\n${STOREFRONT_EDIT_REPLY}`, "A memo from the website"]);
    assert("a named conversation's messages are not in it", !thread.some((m) => m.content === "Filed in a named conversation"));
    assert("another business's messages are not in it", !thread.some((m) => m.content === "The stranger's own business"));
    check("a website voice memo is labelled as one", thread.at(-1)?.voiceMemo, true);

    const theirs = (await (await phoneMessages(messagesRequest(stranger.key))).json()).messages as { content: string }[];
    check("the stranger's key reads the stranger's thread and nothing else", theirs.map((m) => m.content), ["The stranger's own business"]);

    for (let i = 0; i < 60; i++) {
      await prisma.storeMessage.create({ data: { storeId: owner.store.id, role: i % 2 ? "assistant" : "user", content: `line ${i}` } });
    }
    const windowed = (await (await phoneMessages(messagesRequest(owner.key))).json()).messages as { content: string }[];
    check("fifty messages — the window J4 itself reads", windowed.length, 50);
    check("ending with the newest", windowed.at(-1)?.content, "line 59");
  } finally {
    await prisma.authAttempt.deleteMany({}).catch(() => {});
    await prisma.store.deleteMany({ where: { id: { in: [owner.store.id, stranger.store.id] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [owner.user.id, stranger.user.id] } } }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
