// J4 CAN ACTUALLY SEE (2026-09-09) - the live half.
//
//   npx tsx scripts/verify-vision-live.ts
//
// Sean: "Do NOT solve this by making J4 pretend it can see images. We need
// real visual understanding." So this sends a REAL image to a REAL vision
// model and asserts it reports what is actually in the picture. It costs
// money, which is why it is a live-model suite; the request-shaping logic is
// proven for free in verify-conversation-vision.ts.
//
// The image is a 90x30 PNG of three vertical bands, red | green | blue,
// generated with Pillow and verified to decode. The FIRST attempt used
// hand-written PNG bytes and Anthropic answered "Could not process image" -
// which would have read as a vision failure when it was a bad fixture.
import Anthropic from "@anthropic-ai/sdk";

const RED_GREEN_BLUE =
  "iVBORw0KGgoAAAANSUhEUgAAAFoAAAAeCAIAAAAjA54vAAAAaUlEQVR4nO3QQRVAUAAAQRydhRBBMIGEEEcYVxvgH7w3E2APOz/bNo1x3Pug8npeg8rLoO5P2RF2hB1hR9gRdoQdYUfYEXaEHWFH2BF2hB1hR9gRdoQdYUfYEXaEHWFH2BF2hB1hx/T1Aqc4A3IEALroAAAAAElFTkSuQmCC";

async function main(): Promise<void> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: RED_GREEN_BLUE } },
        { type: "text", text: "Name the three colours in this image, left to right, in three words." },
      ],
    }],
  });
  const said = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join(" ")
    .toLowerCase();
  console.log(`the model said: ${said.slice(0, 200)}`);

  const checks: [string, RegExp][] = [["red", /red/], ["green", /green/], ["blue", /blue/]];
  let failed = 0;
  for (const [name, re] of checks) {
    const ok = re.test(said);
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  the model names ${name}`);
  }
  console.log(failed === 0 ? "ALL PASS (3) - the model genuinely saw the image" : `${failed} of 3 FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
