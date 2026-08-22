import {
  resolveAssetContentType,
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
} from "@/lib/businessAssets/uploadAssetFile";

// WHAT GENESIS AGREES TO ACCEPT FROM A PHONE:
//
//   npx tsx scripts/verify-upload-content-type.ts
//
// resolveAssetContentType decides whether a file the owner picked is something
// Genesis can take, and what to call it. It exists because File.type cannot be
// trusted: "some mobile browsers/OS share-sheet flows report an empty string,
// or a generic type like application/octet-stream, for a genuinely ordinary
// photo." So it falls back to the filename's extension.
//
// THE DEFECT THIS FOUND, and it is the most reachable of this class so far,
// because the key comes from a name a person types. Both lookups were bare
// Record indexes:
//
//   EXTENSION_CONTENT_TYPE[ext]   — a file called "notes.constructor" gives
//                                   ext = "constructor", which resolves to the
//                                   inherited Object CONSTRUCTOR. Truthy, so
//                                   `?? null` never fired, and this returned a
//                                   FUNCTION from a signature promising
//                                   `string | null`. The file went on into the
//                                   upload carrying that as its content type
//                                   instead of being refused.
//
//   ALLOWED_CONTENT_TYPES[file.type] — the same shape, and note what its truthy
//                                   branch does: it returns file.type VERBATIM.
//                                   A prototype key would have come back as an
//                                   allowed content type. A real browser will
//                                   not report "constructor" — but this
//                                   function's entire premise is that File.type
//                                   is not to be trusted, so it should not be
//                                   trusted to be plausible either.
//
// The rest of this file is the ordinary contract: the browser's own type wins
// when it is real, the extension is a fallback rather than an override, and an
// unsupported file resolves to null rather than to a guess.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const resolve = (type: string, name: string) => resolveAssetContentType({ type, name });

// ============================================================================
console.log("\n=== 1. A filename can never become a content type by accident ===\n");
// ============================================================================
for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
  const result = resolve("", `notes.${key}`);
  check(`a file named "notes.${key}" is refused`, result, null);
  assert(`and never returns a function (${key})`, typeof result !== "function", typeof result);
}
assert(
  "so an unsupported file is refused rather than uploaded under a nonsense type",
  resolve("", "notes.constructor") === null,
  "the signature says string | null, and it was returning a function"
);

// The same through the browser-reported type, whose truthy branch returned it
// verbatim.
for (const key of ["constructor", "toString", "__proto__"]) {
  check(`a browser reporting "${key}" is not believed`, resolve(key, "photo.png"), "image/png");
}
assert("and a prototype key never comes back as an allowed type",
  resolve("constructor", "unknown.zzz") === null,
  "the truthy branch returned file.type unchanged");

// ============================================================================
console.log("\n=== 2. A type the browser got right is trusted ===\n");
// ============================================================================
for (const type of Object.keys(ALLOWED_CONTENT_TYPES)) {
  check(`${type} is accepted as itself`, resolve(type, "whatever.bin"), type);
}
assert("even when the filename disagrees",
  resolve("application/pdf", "photo.png") === "application/pdf",
  "the extension is a fallback, never an override — it must not overrule a type the browser DID report correctly");

// ============================================================================
console.log("\n=== 3. The extension rescues the real mobile case ===\n");
// ============================================================================
// The bug this function was written for: a genuinely ordinary photo arriving
// with no type at all, or a generic one.
check("an empty type falls back to the extension", resolve("", "holiday.HEIC"), "image/heic");
check("and so does application/octet-stream",
  resolve("application/octet-stream", "receipt.pdf"), "application/pdf");
check("case in the extension does not matter", resolve("", "PHOTO.JPG"), "image/jpeg");
check("jpg and jpeg are the same thing", resolve("", "a.jpeg"), resolve("", "b.jpg"));
check("a docx is a document", resolve("", "chapter.docx"),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

// ============================================================================
console.log("\n=== 4. An unsupported file says so plainly ===\n");
// ============================================================================
check("an unknown extension is refused", resolve("", "archive.zip"), null);
check("an unknown reported type with no usable extension is refused",
  resolve("application/x-msdownload", "installer.exe"), null);
check("a file with no extension at all is refused", resolve("", "README"), null);
check("a dotfile is not an extension match", resolve("", ".gitignore"), null);
check("an empty name is refused", resolve("", ""), null);
check("a trailing dot is refused", resolve("", "photo."), null);

// Every value the resolver can return is one the allow-list actually knows,
// which is what makes the return value safe to hand onward as a content type.
const everyResolvable = [
  ...Object.keys(ALLOWED_CONTENT_TYPES).map((t) => resolve(t, "x.bin")),
  resolve("", "a.png"), resolve("", "a.jpg"), resolve("", "a.jpeg"), resolve("", "a.webp"),
  resolve("", "a.heic"), resolve("", "a.heif"), resolve("", "a.pdf"), resolve("", "a.docx"),
].filter((t): t is string => t !== null);
const strays = everyResolvable.filter((t) => !Object.prototype.hasOwnProperty.call(ALLOWED_CONTENT_TYPES, t));
check("nothing resolvable falls outside the allow-list", [...new Set(strays)], []);
assert("and every resolution is a string",
  everyResolvable.every((t) => typeof t === "string"),
  "the whole defect was a non-string escaping a string-typed return");

// ============================================================================
console.log("\n=== 5. The size ceiling is a real number ===\n");
// ============================================================================
check("uploads are capped at 20MB", MAX_UPLOAD_BYTES, 20 * 1024 * 1024);
assert("which is a positive, whole number of bytes",
  Number.isInteger(MAX_UPLOAD_BYTES) && MAX_UPLOAD_BYTES > 0, String(MAX_UPLOAD_BYTES));

console.log(`\n${failures === 0 ? "All upload-content-type assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
