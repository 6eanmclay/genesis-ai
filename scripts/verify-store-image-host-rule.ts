import { readFileSync } from "fs";
import { isOptimizableImageSrc, OWNED_IMAGE_HOST_SUFFIX } from "@/lib/images/optimizableSource";

// WHICH IMAGE SOURCES WE HAND TO THE OPTIMIZER, AND WHY IT MUST NOT DRIFT:
//
//   npx tsx scripts/verify-store-image-host-rule.ts
//
// ============ WHAT IS ACTUALLY AT STAKE ================================
//
// `next/image` THROWS at render on a source `remotePatterns` does not cover.
// Not a broken thumbnail — a 500 for the whole page. So this predicate is not
// a performance tweak; it is what stands between an owner-approved external
// logo and a dashboard that will not load.
//
// That already happened once. Converting the storefront straight to
// next/image took checkout down on a product whose image sat on a supplier
// host, because `Product.imageUrl` is not always ours: lib/sourcing/adopt.ts
// copies `candidate.imageUrl` off a provider API. `Store.logoUrl` has the same
// shape for a different reason — `update_brand_logo` accepts
// `imageUrl: z.string()` with no URL validation and no ownership resolution.
//
// ============ THE DRIFT THIS EXISTS TO CATCH ===========================
//
// There are TWO statements of the same policy: this predicate, and the
// `remotePatterns` entry in next.config.ts. Two hand-maintained statements of
// one rule is the exact shape that has already cost this repo a missing
// Traffic branch and a mis-lane'd suite. Section 3 reads the real config and
// asserts they still agree, so a change to one that forgets the other fails
// here rather than in production.
//
// A CODE-LANE SUITE ON PURPOSE. The predicate is pure, so the browser proves
// nothing extra about it and would only add the browser lane's flakiness. The
// live behaviour it implies — Blob optimized, supplier raw, SVG refused — is
// asserted against a real server in verify-storefront-image-optimization.ts
// and verify-dashboard-logo-image.ts.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  - ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  - ${detail}` : ""}`);
}

function owned(label: string, src: string): void {
  assert(`OWNED    ${label}`, isOptimizableImageSrc(src) === true, `${src} was treated as foreign`);
}
function foreign(label: string, src: string): void {
  assert(`FOREIGN  ${label}`, isOptimizableImageSrc(src) === false, `${src} would be handed to the optimizer`);
}

console.log("\n1. Sources Genesis owns - these must be optimized\n");

owned("a Blob object", `https://abc123xyz${OWNED_IMAGE_HOST_SUFFIX}/products/a.png`);
owned("a Blob object in a folder", `https://s1${OWNED_IMAGE_HOST_SUFFIX}/designs/2026/a.png`);
owned("a local public asset", "/brand/j4-brain-map.png");
owned("a local asset at the root", "/favicon.ico");

console.log("\n2. Sources we do NOT own - these must fall back to a raw <img>\n");

// The real one. lib/sourcing/adopt.ts puts this shape in Product.imageUrl.
foreign("a supplier CDN (AliExpress)", "https://ae01.alicdn.com/kf/x.jpg");
foreign("any other external host", "https://images.example.com/x.png");
// An owner-approved external logo, which update_brand_logo permits.
foreign("an external brand logo", "https://cdn.somebrand.io/logo.png");

// http, not https: remotePatterns pins the protocol, so the optimizer would
// refuse it and next/image would throw.
foreign("the Blob host over http", `http://abc123xyz${OWNED_IMAGE_HOST_SUFFIX}/a.png`);

// `search: ""` in the config. Without this the two statements disagree and the
// page throws; with it, a cache-busted Blob URL simply renders unoptimized.
foreign("a Blob URL carrying a query string", `https://abc${OWNED_IMAGE_HOST_SUFFIX}/a.png?v=1`);

// A HOST WEARING A LOCAL PATH'S CLOTHES. `//evil.test/x.png` starts with "/",
// so a naive prefix check calls it local and hands an arbitrary origin to the
// optimizer. This is the one case in this file that is a security question
// rather than a cost question.
foreign("a protocol-relative URL", "//evil.test/x.png");

// A host that merely CONTAINS the suffix rather than ending with it.
foreign("a lookalike host", "https://evil.test/public.blob.vercel-storage.com/x.png");
foreign("a suffix-prefixed impostor", `https://evil${OWNED_IMAGE_HOST_SUFFIX}.attacker.test/x.png`);

foreign("an empty string", "");
foreign("a bare filename", "logo.png");
foreign("a data URI", "data:image/png;base64,iVBORw0KGgo=");

console.log("\n3. The predicate and next.config.ts still state the SAME rule\n");

const config = readFileSync("next.config.ts", "utf8");

// Pull the real values out of the config rather than restating them here -
// restating them is how the two drift apart in the first place.
const hostname = /hostname:\s*"([^"]+)"/.exec(config)?.[1] ?? "(none)";
const search = /search:\s*"([^"]*)"/.exec(config)?.[1] ?? "(absent)";
const protocol = /protocol:\s*"([^"]+)"/.exec(config)?.[1] ?? "(none)";

assert(
  "next.config.ts allows exactly the host this predicate calls ours",
  hostname === `*${OWNED_IMAGE_HOST_SUFFIX}`,
  `config says ${hostname}, predicate says *${OWNED_IMAGE_HOST_SUFFIX}`,
);
assert(
  "next.config.ts pins https, as the predicate does",
  protocol === "https",
  `config says ${protocol}`,
);
assert(
  "next.config.ts forbids query strings, as the predicate does",
  search === "",
  `config says ${JSON.stringify(search)} - a predicate that permits them would throw at render`,
);

// SVG stays off. It cannot reach Store.logoUrl or Product.imageUrl today -
// every writer is constrained to png/jpeg/webp and the word "svg" appears
// nowhere in lib/ or app/api - so this guards the thing that could actually
// change: somebody switching it on later.
assert(
  "dangerouslyAllowSVG is not enabled",
  !/dangerouslyAllowSVG\s*:\s*true/.test(config),
  "an optimized SVG is a stored file that can carry script",
);

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
