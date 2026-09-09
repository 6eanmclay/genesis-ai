import {
  toModelMessages,
  imageUrlsOf,
  countImages,
  MAX_IMAGES_PER_REQUEST,
  IMAGE_RECENCY_WINDOW,
} from "@/lib/conversation/messageContent";

// J4 RECEIVES THE IMAGE, NOT THE WORD "PHOTO" (2026-09-09).
//
//   npx tsx scripts/run-db-suites.ts conversation-vision
//
// From production: Sean uploaded a photo and J4 said, honestly, that it could
// not make out the contents. It could not. The conversation history was built
// as `content: m.content`, and the photo lives in `m.changes.imageUrls`, so the
// model received the text "Uploaded 1 photos" and nothing else.
//
// Sean: "Do NOT solve this by making J4 pretend it can see images." So the last
// section of this suite is a REAL call to a vision model with a REAL image, and
// it asserts the model reports what is actually in the picture. It only runs
// with --with-live, because it costs money and needs a key.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const PHOTO = "https://example.blob.vercel-storage.com/candle-1.png";
const PHOTO2 = "https://example.blob.vercel-storage.com/candle-2.png";

async function main(): Promise<void> {
  console.log("\n=== 1. The exact production message shape ===\n");
  {
    // This is what app/dashboard/ai-actions.ts writes on an upload.
    const stored = [
      { role: "user", content: "Uploaded 1 photos", changes: { imageUrls: [PHOTO] } },
      { role: "assistant", content: "I've saved 1 photos to your business files." },
      { role: "user", content: "Review them with me", changes: null },
    ];
    const built = toModelMessages(stored);

    check("the image reaches the request", countImages(built) === 1, `${countImages(built)} image block(s)`);

    const first = built[0];
    check("as a real image block, not text",
      typeof first.content !== "string" && first.content.some((b) => b.type === "image"),
      typeof first.content === "string" ? "still a string!" : JSON.stringify(first.content[0]).slice(0, 70));

    check("the image comes before the owner's words",
      typeof first.content !== "string" && first.content[0].type === "image"
        && first.content[first.content.length - 1].type === "text");

    check("the owner's words are still there",
      typeof first.content !== "string"
        && first.content.some((b) => b.type === "text" && b.text === "Uploaded 1 photos"));

    check("J4's own replies never carry images",
      typeof built[1].content === "string");
  }

  console.log("\n=== 2. The old behaviour, so the regression is visible ===\n");
  {
    const stored = [{ role: "user", content: "Uploaded 1 photos", changes: { imageUrls: [PHOTO] } }];
    const oldWay = stored.map((m) => ({ role: m.role, content: m.content }));
    check("the old mapping really did drop the image",
      countImages(oldWay as never) === 0,
      "this is the bug being fixed - J4 received only the words");
  }

  console.log("\n=== 3. Cost is bounded, deliberately ===\n");
  {
    const many = Array.from({ length: 8 }, (_, i) => ({
      role: "user",
      content: `Uploaded photo ${i}`,
      changes: { imageUrls: [`${PHOTO}?i=${i}`, `${PHOTO2}?i=${i}`] },
    }));
    const built = toModelMessages(many);
    check(`no more than ${MAX_IMAGES_PER_REQUEST} images per request`,
      countImages(built) <= MAX_IMAGES_PER_REQUEST, `${countImages(built)}`);

    // History is re-sent every turn, so an old upload must stop being paid for.
    const old = [
      { role: "user", content: "Uploaded 1 photos", changes: { imageUrls: [PHOTO] } },
      ...Array.from({ length: IMAGE_RECENCY_WINDOW + 2 }, (_, i) => ({
        role: i % 2 === 0 ? "assistant" : "user",
        content: `turn ${i}`,
      })),
    ];
    check("an upload that scrolled out of reach is not re-sent",
      countImages(toModelMessages(old)) === 0,
      `window is ${IMAGE_RECENCY_WINDOW} messages`);
  }

  console.log("\n=== 4. Nothing else changes shape ===\n");
  {
    const plain = [
      { role: "user", content: "how are my orders?" },
      { role: "assistant", content: "Six so far." },
    ];
    const built = toModelMessages(plain);
    check("messages without images stay plain strings",
      built.every((m) => typeof m.content === "string"));
    check("roles are preserved", built.map((m) => m.role).join(",") === "user,assistant");
  }

  console.log("\n=== 5. Malformed attachments cannot break a turn ===\n");
  {
    check("no changes", imageUrlsOf({ role: "user", content: "x" }).length === 0);
    check("changes is not an object", imageUrlsOf({ role: "user", content: "x", changes: "nope" }).length === 0);
    check("imageUrls is not an array",
      imageUrlsOf({ role: "user", content: "x", changes: { imageUrls: "one" } }).length === 0);
    check("non-string entries are dropped",
      imageUrlsOf({ role: "user", content: "x", changes: { imageUrls: [PHOTO, 42, null] } }).length === 1);
    check("a non-http value is refused",
      imageUrlsOf({ role: "user", content: "x", changes: { imageUrls: ["javascript:alert(1)"] } }).length === 0,
      "only http(s) urls reach the model");
  }

  // THE LIVE PROOF LIVES IN verify-vision-live.ts.
  //
  // It was here, and that was a mistake: constructing an Anthropic client in
  // this file made the WHOLE suite live-model, so suiteLanes held all of it
  // back from an ordinary run - the fifteen assertions above would only ever
  // have executed with --with-live. Logic that costs nothing is checked on
  // every run; only the call that costs money is gated.
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
