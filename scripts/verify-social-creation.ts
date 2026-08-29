import { readFileSync } from "fs";
import { join } from "path";
import { SocialContentSchema, SocialPostSchema, ENTITY_REGISTRY } from "@/lib/businessModel/entities";
import {
  SOCIAL_PLATFORMS,
  emptyContent,
  socialPlatform,
  X_MAX_CHARACTERS,
} from "@/lib/social/platforms";
import {
  draftSummary,
  groupPosts,
  isReadyToPublish,
  socialDraftHref,
  socialHref,
  whatIsMissing,
} from "@/lib/social/socialPresentation";

// THE SOCIAL CREATION FOUNDATION:
//
//   npx tsx scripts/verify-social-creation.ts
//
// ============ WHY THIS SUITE EXISTS ====================================
//
// Two reasons, and the first is a standing rule rather than a feature.
//
// ARCHITECTURE.md's mirrored-registry invariant: "A registry that mirrors
// another must carry a runtime cross-check asserting every referenced name
// resolves in the registry it mirrors." lib/social/platforms.ts mirrors two
// things the compiler cannot check at runtime — the IntegrationProvider enum
// (a type, erased) and the content union's `kind` values (also erased). A drift
// in either offers a platform whose posts cannot be stored, or names a
// connector that does not exist.
//
// The second is Sean's actual requirement, 2026-08-28: "Keep platform-specific
// content generation separate — never assume one caption can simply be copied
// across platforms." That is enforced by the shapes rather than by discipline,
// and a suite is how it stays enforced.

let failures = 0;
let passes = 0;

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
/** Comments are prose, not code — a claim about source must not match a note. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

function main(): void {
  // ======================================================================
  console.log("\n=== 1. The registry mirrors what it claims to mirror ===\n");
  // ======================================================================

  eq("four platforms, in the order Sean asked for",
    SOCIAL_PLATFORMS.map((p) => p.id), ["instagram", "facebook", "x", "tiktok"]);

  // EVERY PLATFORM ID MUST BE A CONTENT KIND. The union is erased at runtime,
  // so this parses a real empty post for each and checks the discriminator
  // survives — a platform whose shape does not exist cannot be stored at all.
  for (const platform of SOCIAL_PLATFORMS) {
    const parsed = SocialContentSchema.safeParse(emptyContent(platform.id));
    assert(`${platform.id}: the content union can hold it`,
      parsed.success && parsed.data.kind === platform.id,
      parsed.success ? parsed.data.kind : JSON.stringify(parsed.error.issues.slice(0, 2)));
  }

  // AND EVERY NON-NULL PUBLISH PROVIDER MUST BE A REAL ENUM VALUE. Read from
  // the schema itself rather than a copy of the list, or this check would
  // mirror the thing it is checking.
  const schemaSrc = read("prisma", "schema.prisma");
  const enumBlock = schemaSrc.slice(
    schemaSrc.indexOf("enum IntegrationProvider {"),
    schemaSrc.indexOf("}", schemaSrc.indexOf("enum IntegrationProvider {")),
  );
  const enumValues = enumBlock
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z_]*$/.test(line));
  assert("the provider enum was actually read", enumValues.length > 5, `${enumValues.length} values`);

  for (const platform of SOCIAL_PLATFORMS) {
    if (platform.publishProvider === null) continue;
    assert(`${platform.id}: its publisher is a real IntegrationProvider`,
      enumValues.includes(platform.publishProvider),
      `${platform.publishProvider} vs the enum's ${enumValues.length} values`);
  }

  // THE ONE THAT IS HONESTLY NULL. X has no connector and adding one needs a
  // migration; asserting it stops somebody "fixing" the null with a guess.
  eq("X declares no publisher, because none exists",
    socialPlatform("x")?.publishProvider, null);
  assert("and the three that do exist are named",
    SOCIAL_PLATFORMS.filter((p) => p.publishProvider !== null).length === 3);

  assert("socialPost is a registered entity type",
    Object.prototype.hasOwnProperty.call(ENTITY_REGISTRY, "socialPost"));

  // ======================================================================
  console.log("\n=== 2. One caption cannot be copied across platforms ===\n");
  // ======================================================================
  //
  // Sean's requirement, tested as a property of the data rather than a promise
  // in a comment. The shapes have no field in common that carries "the post",
  // so there is nothing to copy even by accident.

  const shapes = SOCIAL_PLATFORMS.map((p) => Object.keys(emptyContent(p.id)).filter((k) => k !== "kind"));
  const shared = shapes.reduce((acc, keys) => acc.filter((k) => keys.includes(k)));
  eq("no field is common to all four shapes", shared, []);

  // ZOD STRIPS RATHER THAN REFUSES, so the property worth asserting is that the
  // foreign field does not SURVIVE — an X body handed to Instagram becomes an
  // empty Instagram post, never an Instagram post carrying X's text. Naming
  // this "cannot be parsed" would have been false, and a false test name is how
  // somebody later fixes the wrong thing.
  const crossed = SocialContentSchema.safeParse({ kind: "instagram", text: "just a line" });
  assert("an X body does not survive into an Instagram post",
    crossed.success && !("text" in crossed.data),
    JSON.stringify(crossed.success ? crossed.data : "refused"));
  // And the action refuses the mismatch outright, which is the line that
  // actually protects the stored row.
  assert("and the save action refuses a platform/content mismatch",
    /input\.content\.kind !== platform\.id/.test(
      read("app", "b", "[slug]", "studio", "social", "actions.ts")),
    "the union is unrepresentable in our code but says nothing about the wire");

  // Instagram is visual-first, and that is a rule with teeth: a caption alone
  // is not a post.
  assert("Instagram is not ready on a caption alone",
    !isReadyToPublish({ kind: "instagram", imageBrief: "a ring", imageUrl: null, caption: "hello", hashtags: [] }));
  assert("and is ready once there is a picture",
    isReadyToPublish({ kind: "instagram", imageBrief: "a ring", imageUrl: "https://x/i.png", caption: "hello", hashtags: [] }));
  eq("and says which half is missing",
    whatIsMissing({ kind: "instagram", imageBrief: "", imageUrl: null, caption: "hello", hashtags: [] }),
    "This needs a picture — Instagram posts are the image first.");

  // X's limit is the format.
  assert("X refuses a post over the limit",
    !isReadyToPublish({ kind: "x", text: "a".repeat(X_MAX_CHARACTERS + 1) }));
  assert("and accepts one exactly at it",
    isReadyToPublish({ kind: "x", text: "a".repeat(X_MAX_CHARACTERS) }));
  eq("and counts how far over",
    whatIsMissing({ kind: "x", text: "a".repeat(X_MAX_CHARACTERS + 12) }),
    "This is 12 characters over the limit.");

  // TikTok is a plan before it is a caption.
  assert("TikTok is not ready on a caption alone",
    !isReadyToPublish({ kind: "tiktok", hook: "", shots: [], caption: "watch this" }));
  assert("and needs a shot, not just a hook",
    !isReadyToPublish({ kind: "tiktok", hook: "look at this", shots: [], caption: "" }));
  assert("and is ready with a hook and a shot",
    isReadyToPublish({
      kind: "tiktok",
      hook: "look at this",
      shots: [{ id: "s1", description: "hands closing the clasp", seconds: null }],
      caption: "",
    }));

  // Facebook earns its place by being answered.
  assert("Facebook needs something to say",
    !isReadyToPublish({ kind: "facebook", body: "", question: "what do you think?" }));

  // ======================================================================
  console.log("\n=== 3. A draft says what is in it, in its own terms ===\n");
  // ======================================================================
  //
  // The obvious implementation is "first forty characters of the caption",
  // which assumes all four have a caption — the exact assumption the union
  // exists to prevent. So each branch is checked separately.

  eq("an empty Instagram draft says the picture is missing",
    draftSummary({ kind: "instagram", imageBrief: "", imageUrl: null, caption: "", hashtags: [] }),
    "no picture yet");
  eq("a described one says so",
    draftSummary({ kind: "instagram", imageBrief: "a copper ring", imageUrl: null, caption: "hi", hashtags: ["copper"] }),
    "picture described · caption written · 1 tags");
  eq("an empty X draft counts nothing",
    draftSummary({ kind: "x", text: "   " }), "nothing written yet");
  eq("and a written one counts characters",
    draftSummary({ kind: "x", text: "hello" }), `5 of ${X_MAX_CHARACTERS} characters`);
  eq("a TikTok counts its shots",
    draftSummary({ kind: "tiktok", hook: "look", shots: [
      { id: "a", description: "one", seconds: null },
      { id: "b", description: "two", seconds: null },
    ], caption: "" }),
    "hook written · 2 shots");
  eq("a Facebook draft says whether it asks anything",
    draftSummary({ kind: "facebook", body: "we opened", question: "" }),
    "post written · no question yet");

  // ======================================================================
  console.log("\n=== 4. Links, grouping, and the stored shape ===\n");
  // ======================================================================

  eq("starting a post carries the platform",
    socialHref("/b/acme", "instagram"), "/b/acme/studio/social?platform=instagram");
  // BOTH PARAMETERS, always — the workspace has to know which of four screens
  // to render before it has fetched anything.
  eq("reopening carries the platform AND the post",
    socialDraftHref("/b/acme", "tiktok", "p1"),
    "/b/acme/studio/social?platform=tiktok&post=p1");
  eq("and anything odd in an id survives the trip",
    socialDraftHref("/b/acme", "x", "p/1&2"),
    "/b/acme/studio/social?platform=x&post=p%2F1%262");

  const grouped = groupPosts([
    { postId: "a", publishedAt: null },
    { postId: "b", publishedAt: "2026-08-28T00:00:00.000Z" },
    { postId: "c", publishedAt: null },
  ]);
  eq("unpublished work is in progress", grouped.inProgress.map((p) => p.postId), ["a", "c"]);
  eq("and published work is its own group", grouped.published.map((p) => p.postId), ["b"]);
  eq("every post lands in exactly one group",
    grouped.inProgress.length + grouped.published.length, 3);

  // A REAL ROW ROUND-TRIPS. The schema is what the database column is validated
  // against, so a shape it cannot parse is a draft nobody can reopen.
  const stored = SocialPostSchema.safeParse({
    platform: "tiktok",
    name: "Ring close-up",
    content: { kind: "tiktok", hook: "look", shots: [{ id: "s1", description: "hands", seconds: 3 }], caption: "c" },
    updatedAt: "2026-08-28T00:00:00.000Z",
    publishedAt: null,
    publishedUrl: null,
  });
  assert("a saved post parses back out",
    stored.success, stored.success ? "" : JSON.stringify(stored.error.issues.slice(0, 2)));
  assert("and publishing fields default to null rather than absent",
    SocialPostSchema.safeParse({
      platform: "x", content: { kind: "x", text: "hi" },
    }).success);

  // ======================================================================
  console.log("\n=== 5. Nothing pretends to publish ===\n");
  // ======================================================================
  //
  // The foundation is built before the integrations, which is exactly the
  // condition under which a convincing fake gets written. These assert the
  // absence rather than trusting it.

  const publisherSrc = codeOnly(read("lib", "social", "publisher.ts"));
  assert("the publisher registry is empty",
    /new Map<string, \(\) => SocialPublisher>\(\)/.test(publisherSrc),
    "a pre-registered publisher would be one nobody wrote");
  assert("and nothing registers one yet",
    !/registerPublisher\(\s*["'`]/.test(codeOnly(read("lib", "social", "publisher.ts"))),
    "registering one is the whole change when a connection is ready");

  const composerSrc = codeOnly(read("app", "b", "[slug]", "studio", "social", "SocialComposer.tsx"));
  assert("CONTROL: the composer offers no Publish button",
    !/>\s*Publish\s*</.test(composerSrc) && !/Post to /.test(composerSrc),
    "a control that appears to post while nothing is connected is the failure this codebase keeps being corrected for");
  assert("but it does say why, rather than staying silent",
    /blockedReason/.test(composerSrc));

  // AND THE SAVE PATH TOUCHES NO NETWORK. Save on the design side once waited
  // on the supplier's heaviest call; the button that must be instant cannot
  // depend on anybody being up.
  const actionsSrc = codeOnly(read("app", "b", "[slug]", "studio", "social", "actions.ts"));
  assert("CONTROL: saving a draft calls no platform",
    !/publisherFor|fetch\(/.test(actionsSrc),
    "Save must never depend on a network Genesis does not control");
  assert("and it takes the slug-shaped permission helper",
    /requireBusiness\(/.test(actionsSrc) && !/requireStorePermission\(/.test(actionsSrc),
    "requireStorePermission's second parameter is a store ID — this cost two rounds of debugging");

  console.log(failures === 0 ? `\nAll ${passes} checks passed.` : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
