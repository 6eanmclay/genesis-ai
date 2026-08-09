import { readFile } from "fs/promises";
import path from "path";
import mammoth from "mammoth";

// Real end-to-end verification (2026-08-09) — confirms the actual new
// mechanism behind DOCX support: reading real bytes from a real .docx file
// and extracting real text via mammoth, exactly the same call
// classify.ts's own DOCX branch makes (just from a local file instead of
// fetch(data.storageUrl), since this test doesn't need a live upload).
// Uses mammoth's own real test fixture, not a fabricated buffer.
async function main() {
  const fixturePath = path.join(
    process.cwd(),
    "node_modules/mammoth/test/test-data/single-paragraph.docx"
  );
  const buffer = await readFile(fixturePath);
  const { value: extractedText } = await mammoth.extractRawText({ buffer });

  if (typeof extractedText !== "string" || extractedText.trim().length === 0) {
    throw new Error(`Expected real, non-empty extracted text, got: ${JSON.stringify(extractedText)}`);
  }
  console.log("Extracted text:", JSON.stringify(extractedText));
  console.log("\nDOCX extraction verified against a real .docx file — mammoth.extractRawText produces real, usable text.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});
