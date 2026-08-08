// Temporary, unauthenticated diagnostic endpoint (2026-08-07) — isolates
// whether Vercel's own platform buffers a Route Handler's ReadableStream
// response, independent of auth/Anthropic/app logic. Enqueues 10 numbered
// chunks with a real delay between each; if the real deployed platform
// delivers them progressively, curl (with --no-buffer) sees each line
// arrive on its own real timestamp. If Vercel buffers, all 10 lines land
// at once at the end regardless of the server-side delays. Delete once
// the real streaming-buffering question is settled — not meant to ship
// long-term.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 1; i <= 10; i++) {
        controller.enqueue(encoder.encode(`chunk ${i} at ${Date.now()}\n`));
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
