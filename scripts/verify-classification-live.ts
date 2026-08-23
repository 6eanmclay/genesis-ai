import "dotenv/config";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { isStaffPolicyDocument, getStaffPolicyGap } from "@/lib/businessModel/staffPolicyGap";

// DOES A REAL HANDBOOK CLASSIFY AS ONE, AND DOES THE ASK THEN CLOSE?
//
//   npx tsx scripts/verify-classification-live.ts
//
// lib/businessAssets/classify.ts makes a real model call per upload and has no
// live coverage anywhere. That matters more than it looks: an upload lands with
// category "unclassified" and classification is what fills it in, so
// classification is the step that CLOSES the employee-handbook ask. The one step
// that closes the loop is the one step never tested.
//
// TWO THINGS ARE NEEDED, and the second was a discovery. Classification sends
// the document to the model as a URL for the model to fetch — so this needs a
// publicly reachable fixture as well as a key. Naming both rather than
// discovering the second one mid-run.
//
// THE LIVE HALF HAS NEVER RUN. Said plainly at the top rather than implied: the
// deterministic half below is real and passes; everything past the gate is
// written and unexercised, and it should be read that way until it has been.

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

const uniq = () => Math.random().toString(36).slice(2, 10);

async function main() {
  // No database yet. The contract below is a pure function, and requiring one
  // here would mean the half that CAN always run only runs where a test
  // database happens to be configured.

  // ==========================================================================
  console.log("\n=== The contract the live half will be judged against ===\n");
  // ==========================================================================
  // Written first and deliberately: these are the labels the matcher accepts,
  // so a live run either produces one of them or it does not. Fixing the
  // expectation in advance is what stops a disappointing result being explained
  // away afterwards by widening the matcher.
  const ACCEPTED = ["employee_handbook", "employee_document", "staff_handbook", "sop", "onboarding_pack", "hr_policy"];
  for (const category of ACCEPTED) {
    assert(`"${category}" would satisfy the ask`,
      isStaffPolicyDocument({ fileType: "document", category }), category);
  }
  const REJECTED = ["supplier_invoice", "business_license", "product_spec_sheet", "receipt", "financial_statement"];
  for (const category of REJECTED) {
    assert(`"${category}" would not`,
      !isStaffPolicyDocument({ fileType: "document", category }), category);
  }
  // The classifier is told never to answer "document" or "file". If a live run
  // returns one, the prompt has drifted rather than the matcher being too narrow.
  assert("a vague label satisfies nothing",
    !isStaffPolicyDocument({ fileType: "document", category: "document" }),
    "classify.ts's prompt forbids vague labels; this is how we would notice it stopped");

  // ==========================================================================
  const key = process.env.ANTHROPIC_API_KEY;
  const fixtureUrl = process.env.CLASSIFY_FIXTURE_URL;
  if (!key || !fixtureUrl) {
    console.log("\n=== Live classification: SKIPPED ===\n");
    console.log(
      `${!key ? "ANTHROPIC_API_KEY is not set. " : ""}` +
        `${!fixtureUrl ? "CLASSIFY_FIXTURE_URL is not set. " : ""}\n\n` +
        "Both are required, and the second is not obvious: classify.ts sends the\n" +
        "document to the model as a URL for the model to fetch, so a local file is\n" +
        "not enough — the fixture has to be publicly reachable. Point\n" +
        "CLASSIFY_FIXTURE_URL at a real employee handbook PDF and re-run.\n\n" +
        "What did NOT run: whether a real handbook classifies as a label the\n" +
        "matcher accepts, and whether the employee-handbook ask then closes.\n" +
        "Skipped, not passed — nothing above this line touched the model.\n"
    );
    process.exit(failures === 0 ? 0 : 1);
  }

  // ==========================================================================
  console.log("\n=== Live: a real handbook, classified ===\n");
  // ==========================================================================
  // Only now, because only now is one used.
  await requireTestDatabase(prismaSystem);
  // Only now, because only now is one used.
  await requireTestDatabase(prismaSystem);
  const { classifyAndExtractAsset } = await import("@/lib/businessAssets/classify");

  const owner = await prisma.user.create({ data: { email: `cl-${uniq()}@test.local` } });
  const shop = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `cl-${uniq()}` },
  });
  // The evidence that makes the ask justified in the first place.
  await prisma.businessRecord.create({
    data: {
      storeId: shop.id, entityType: "employee", sourceProvider: "owner", externalId: `emp-${uniq()}`,
      data: { name: "Ada", title: null, roles: [], email: null, startedAt: null, status: "active", locationId: null },
    },
  });
  assert("the ask is justified before the upload",
    (await getStaffPolicyGap(shop.id)) !== null, "no gap means this proves nothing");

  const uploaded = await prisma.businessRecord.create({
    data: {
      storeId: shop.id, entityType: "asset", sourceProvider: "genesis_upload", externalId: fixtureUrl,
      data: {
        fileType: "document", category: "unclassified", storageUrl: fixtureUrl,
        originalFilename: "handbook.pdf", summary: null, extractionConfidence: null,
        relatedRecordId: null, relatedEntityType: null,
      },
    },
  });
  // An upload lands unclassified, and the ask correctly still stands.
  assert("an unclassified upload does not close it yet",
    (await getStaffPolicyGap(shop.id)) !== null,
    "a file nobody has read is not knowledge of how the business runs");

  const result = await classifyAndExtractAsset(uploaded, shop.id);
  // The label lives on `classification`, not on the result itself.
  const classified = result?.classification ?? null;
  console.log(`\n  The model returned: ${JSON.stringify(classified?.category ?? null)}\n`);

  assert("the model returned a classification at all", result !== null,
    "a null here is a provider failure, not a wrong answer");
  assert("and not a vague one",
    classified?.category !== "document" && classified?.category !== "file",
    String(classified?.category));
  // THE QUESTION THIS SUITE EXISTS FOR.
  assert("a real handbook classifies as something the matcher accepts",
    isStaffPolicyDocument({ fileType: "document", category: classified?.category }),
    `got "${classified?.category}" — if this fails, record the label rather than widening the matcher to fit it`);

  // ==========================================================================
  console.log("\n=== Live: and the loop closes ===\n");
  // ==========================================================================
  await prisma.businessRecord.updateMany({
    where: { id: uploaded.id, storeId: shop.id },
    data: { data: { ...(uploaded.data as object), category: classified?.category ?? "unclassified" } },
  });
  check("the ask is satisfied", await getStaffPolicyGap(shop.id), null);

  await prisma.store.deleteMany({ where: { id: shop.id } });
  await prisma.user.deleteMany({ where: { id: owner.id } });

  console.log(`\n${failures === 0 ? "All classification assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
