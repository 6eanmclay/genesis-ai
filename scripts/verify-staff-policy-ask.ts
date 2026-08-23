import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  getStaffPolicyGap,
  proposeStaffPolicyGap,
  staffPolicyAsk,
  isStaffPolicyDocument,
  STAFF_POLICY_TOPIC,
} from "@/lib/businessModel/staffPolicyGap";
import { speakNewFindings } from "@/lib/intelligence/proactive";

// THE ONE DOCUMENT J4 CAN JUSTIFY ASKING FOR:
//
//   npx tsx scripts/run-db-suites.ts staff-policy-ask
//
// J4_IDENTITY.md's governing test is that an ask carries a real, specific reason
// already in evidence — never a category of information that is generically nice
// to have. Most of this suite is the NEGATIVE side of that: the businesses J4
// must say nothing to.

let failures = 0;
const results: { name: string; ok: boolean }[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const uniq = () => Math.random().toString(36).slice(2, 10);

const addEmployee = (storeId: string, name: string, status: string | null) =>
  prisma.businessRecord.create({
    data: {
      storeId,
      entityType: "employee",
      sourceProvider: "owner",
      externalId: `emp-${uniq()}`,
      data: { name, title: null, roles: [], email: null, startedAt: null, status, locationId: null },
    },
  });

const addAsset = (storeId: string, fileType: string, category: string) =>
  prisma.businessRecord.create({
    data: {
      storeId,
      entityType: "asset",
      sourceProvider: "owner",
      externalId: `ast-${uniq()}`,
      data: {
        fileType,
        category,
        storageUrl: "https://example.test/f",
        originalFilename: "f",
        summary: null,
        extractionConfidence: null,
        relatedRecordId: null,
        relatedEntityType: null,
      },
    },
  });

const askOf = (storeId: string) =>
  prisma.genesisObservation.findFirst({ where: { storeId, dedupeKey: STAFF_POLICY_TOPIC } });

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({ data: { email: `sp-${uniq()}@test.local` } });
  const shop = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `sp-${uniq()}` },
  });
  const neighbour = await prisma.store.create({
    data: { userId: owner.id, name: "Iron Gym", slug: `sp-n-${uniq()}` },
  });

  // ==========================================================================
  console.log("\n=== 1. No evidence, no ask — the generic case, refused ===\n");
  // ==========================================================================
  // A BUSINESS WITH NOBODY ON RECORD IS ASKED NOTHING, FOREVER. This is the
  // whole governing test: J4 does not ask because most businesses have a
  // handbook, it asks because THIS owner has people and J4 has nothing about
  // how they are run.
  check("a business with no employees has no gap", await getStaffPolicyGap(shop.id), null);
  await proposeStaffPolicyGap(shop.id);
  check("and nothing is raised", await askOf(shop.id), null);
  check("so J4 says nothing", (await speakNewFindings(shop.id)).spoken, 0);

  // Former staff are not evidence that policies are live today.
  await addEmployee(shop.id, "Someone Who Left", "former");
  check("former staff alone are not evidence", await getStaffPolicyGap(shop.id), null);
  await proposeStaffPolicyGap(shop.id);
  check("still nothing raised", await askOf(shop.id), null);

  // ==========================================================================
  console.log("\n=== 2. Real people on record — the ask is justified ===\n");
  // ==========================================================================
  await addEmployee(shop.id, "Ada", "active");
  await addEmployee(shop.id, "Grace", null);
  const gap = await getStaffPolicyGap(shop.id);
  assert("a team on record is a gap", gap !== null, JSON.stringify(gap));
  // Unknown status counts as active: the field is nullable, and treating "not
  // stated" as "gone" would silently drop real staff from the evidence.
  check("counting the ones actually there, including unstated status",
    gap?.activeEmployees, 2);

  const sentence = staffPolicyAsk(gap!);
  assert("the ask carries its own evidence",
    sentence.includes("2 people on your team"), sentence);
  assert("and asks for the specific thing",
    sentence.includes("employee handbook"), sentence);
  // Nothing about mechanism. The owner has no idea a finding or a cycle exists.
  assert("naming no internals",
    !/observation|finding|cycle|record|category|asset/i.test(sentence), sentence);
  check("one person reads as one person",
    staffPolicyAsk({ activeEmployees: 1 }).includes("one person on your team"), true);

  // ==========================================================================
  console.log("\n=== 3. Raised once, spoken once ===\n");
  // ==========================================================================
  await proposeStaffPolicyGap(shop.id);
  await proposeStaffPolicyGap(shop.id);
  await proposeStaffPolicyGap(shop.id);
  check("three sweeps raise one finding",
    await prisma.genesisObservation.count({ where: { storeId: shop.id, dedupeKey: STAFF_POLICY_TOPIC } }), 1);

  check("J4 asks once", (await speakNewFindings(shop.id)).spoken, 1);
  const spoken = await prisma.storeMessage.findMany({
    where: { storeId: shop.id, role: "assistant" }, orderBy: { createdAt: "asc" },
  });
  check("one message exists", spoken.length, 1);
  assert("and it is the ask", spoken[0].content.includes("employee handbook"), spoken[0].content);

  // The gap remains open. It must not be asked again.
  for (let i = 0; i < 3; i++) {
    await proposeStaffPolicyGap(shop.id);
    check(`still open after sweep ${i + 1}, still silent`, (await speakNewFindings(shop.id)).spoken, 0);
  }
  check("still exactly one message",
    (await prisma.storeMessage.count({ where: { storeId: shop.id, role: "assistant" } })), 1);

  // ==========================================================================
  console.log("\n=== 4. Cross-business: the neighbour is never asked ===\n");
  // ==========================================================================
  check("the neighbour has no gap of its own", await getStaffPolicyGap(neighbour.id), null);
  await proposeStaffPolicyGap(neighbour.id);
  check("nothing raised there", await askOf(neighbour.id), null);
  check("and nothing said there",
    await prisma.storeMessage.count({ where: { storeId: neighbour.id } }), 0);
  // This store's employees are not the neighbour's evidence.
  check("this store's team does not justify an ask there",
    await getStaffPolicyGap(neighbour.id), null);

  // ==========================================================================
  console.log("\n=== 5. Satisfied means silent, and honest afterwards ===\n");
  // ==========================================================================
  // The open vocabulary is why this matches a set. An owner uploads their
  // handbook and it classifies as `employee_document`, `sop` or something the
  // classifier invented — waiting for one exact spelling would mean J4 keeps
  // asking for the document it is already holding.
  for (const category of ["employee_handbook", "employee_document", "sop", "staff_policies", "onboarding_pack"]) {
    assert(`a document classified "${category}" satisfies it`,
      isStaffPolicyDocument({ fileType: "document", category }), category);
  }
  // A photo of the staff is not a policy.
  assert("a staff PHOTO does not satisfy it",
    !isStaffPolicyDocument({ fileType: "photo", category: "staff_photo" }),
    "the file type is checked before the label");
  assert("nor does an unrelated document",
    !isStaffPolicyDocument({ fileType: "document", category: "supplier_invoice" }),
    "supplier_invoice");

  await addAsset(shop.id, "document", "employee_document");
  check("uploading it closes the gap", await getStaffPolicyGap(shop.id), null);
  await proposeStaffPolicyGap(shop.id);
  const afterUpload = await askOf(shop.id);
  check("the finding is resolved", afterUpload?.status, "RESOLVED");

  // HISTORICALLY TRUTHFUL. What J4 asked stays asked — it was true when it
  // asked, and deleting it would make the conversation unreliable as a record.
  const stillThere = await prisma.storeMessage.findMany({
    where: { storeId: shop.id, role: "assistant" },
  });
  check("the message J4 sent is still there", stillThere.length, 1);
  assert("still saying what it said",
    stillThere[0].content.includes("employee handbook"), stillThere[0].content);
  check("and J4 does not ask again", (await speakNewFindings(shop.id)).spoken, 0);

  // ==========================================================================
  console.log("\n=== 6. The evidence disappearing also closes it ===\n");
  // ==========================================================================
  // Not only the document satisfies the gap — the team leaving removes the
  // reason to ask at all, which is the same thing said the other way.
  const bare = await prisma.store.create({
    data: { userId: owner.id, name: "Solo Trader", slug: `sp-s-${uniq()}` },
  });
  await addEmployee(bare.id, "Only Staffer", "active");
  await proposeStaffPolicyGap(bare.id);
  assert("a one-person team is asked", (await askOf(bare.id))?.status === "ACTIVE");
  await prisma.businessRecord.deleteMany({ where: { storeId: bare.id, entityType: "employee" } });
  await proposeStaffPolicyGap(bare.id);
  check("and when they are gone, the ask is withdrawn",
    (await askOf(bare.id))?.status, "RESOLVED");

  await prisma.store.deleteMany({ where: { id: { in: [shop.id, neighbour.id, bare.id] } } });
  await prisma.user.deleteMany({ where: { id: owner.id } });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
