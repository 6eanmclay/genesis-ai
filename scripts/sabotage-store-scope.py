"""Reopen the cross-store hole deliberately, one shape at a time.

The point is not that the suite goes red. It is that the suite goes red BECAUSE
it sees another business's data come back through a direct, unauthenticated
call — the exact thing the vulnerability allowed.

Every break asserts its own anchor applied first. A sabotage edit that silently
misses turns a green run into false proof of coverage, which has happened in
this codebase before.

    python scripts/sabotage-store-scope.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CREATE = "app/b/[slug]/studio/create/actions.ts"
SOCIAL = "app/b/[slug]/studio/social/actions.ts"

BREAKS = [
    # ---- the vulnerability itself, restored exactly as it was ----
    (
        "socialDraftsFor takes a caller-supplied storeId again",
        SOCIAL,
        'export async function socialDraftsFor(slug?: string): Promise<SocialDraftRow[]> {\n'
        '  const { store } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);\n'
        '  const rows = await prisma.businessRecord.findMany({\n'
        '    where: { storeId: store.id, entityType: "socialPost", sourceProvider: DRAFT_SOURCE },',
        'export async function socialDraftsFor(storeId?: string): Promise<SocialDraftRow[]> {\n'
        '  const rows = await prisma.businessRecord.findMany({\n'
        '    where: { storeId, entityType: "socialPost", sourceProvider: DRAFT_SOURCE },',
    ),
    (
        "savedDesignsFor takes a caller-supplied storeId again",
        CREATE,
        'export async function savedDesignsFor(slug?: string): Promise<SavedDesignRow[]> {\n'
        '  const { store } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);\n'
        '  const rows = await prisma.businessRecord.findMany({\n'
        '    where: { storeId: store.id, entityType: "design", sourceProvider: DRAFT_SOURCE },',
        'export async function savedDesignsFor(storeId?: string): Promise<SavedDesignRow[]> {\n'
        '  const rows = await prisma.businessRecord.findMany({\n'
        '    where: { storeId, entityType: "design", sourceProvider: DRAFT_SOURCE },',
    ),
    # ---- the guard dropped, the slug parameter kept ----
    (
        "loadSocialDraft drops its guard",
        SOCIAL,
        '  const { store } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);\n'
        '  const row = await prisma.businessRecord.findFirst({\n'
        '    where: {\n'
        '      storeId: store.id,',
        '  const store = { id: slug as string };\n'
        '  const row = await prisma.businessRecord.findFirst({\n'
        '    where: {\n'
        '      storeId: store.id,',
    ),
    (
        "loadDesignDraft drops its guard",
        CREATE,
        '  const { store } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);\n'
        '  const row = await prisma.businessRecord.findFirst({\n'
        '    where: { storeId: store.id, entityType: "design", sourceProvider: DRAFT_SOURCE, externalId: draftId },',
        '  const store = { id: slug as string };\n'
        '  const row = await prisma.businessRecord.findFirst({\n'
        '    where: { storeId: store.id, entityType: "design", sourceProvider: DRAFT_SOURCE, externalId: draftId },',
    ),
    # ---- the guard kept, but after the read ----
    (
        "savedDesignsFor authorizes after it queries",
        CREATE,
        '  const { store } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);\n'
        '  const rows = await prisma.businessRecord.findMany({\n'
        '    where: { storeId: store.id, entityType: "design", sourceProvider: DRAFT_SOURCE },',
        '  const rows = await prisma.businessRecord.findMany({\n'
        '    where: { storeId: (await prisma.store.findUnique({ where: { slug } }))?.id, entityType: "design", sourceProvider: DRAFT_SOURCE },',
        ('  const drafts: SavedDesignRow[] = [];',
         '  await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);\n  const drafts: SavedDesignRow[] = [];'),
    ),
    # ---- the regression guard itself: does it catch a NEW offender? ----
    (
        "a new unguarded action taking a storeId is added",
        SOCIAL,
        "export async function socialDraftsFor(",
        'export async function brandNewLeak(storeId: string): Promise<number> {\n'
        '  return prisma.businessRecord.count({ where: { storeId } });\n'
        '}\n\n'
        "export async function socialDraftsFor(",
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-scope.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts store-scope-db",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        text = io.open(out, encoding="utf-16-le", errors="replace").read()
    except OSError:
        return False, ""
    green = "0 failed," in text and "1/1 database-backed suites pass." in text
    fails = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("FAIL ")]
    # The harness writes UTF-16 and this console is cp1252; the failure detail
    # carries em-dashes that cannot be encoded. Flattened to ASCII so a real
    # finding is never lost to a print error.
    # Every failure, not the first few: the one that matters most here is the
    # LEAKED line, and it sorts last. Truncating the list once hid it.
    joined = " | ".join(fails)
    return green, joined.encode("ascii", "replace").decode("ascii")


def main() -> int:
    print("Confirming the suite is green before breaking anything...")
    green, _ = run_suite()
    if not green:
        print("ABORT — not green to begin with. Nothing below would mean anything.")
        return 1
    print("  green.\n")

    unproven = []
    for entry in BREAKS:
        name, path, old, new = entry[0], entry[1], entry[2], entry[3]
        extra = entry[4] if len(entry) > 4 else None
        full = os.path.join(ROOT, path)
        original = io.open(full, encoding="utf-8", newline="").read()
        crlf = "\r\n" in original
        source = original.replace("\r\n", "\n")

        if old not in source:
            print(f"BROKEN SABOTAGE  {name} — anchor not found in {path}")
            unproven.append(f"{name} (anchor missing)")
            continue
        broken = source.replace(old, new, 1)
        if extra:
            if extra[0] not in broken:
                print(f"BROKEN SABOTAGE  {name} — second anchor not found")
                unproven.append(f"{name} (second anchor missing)")
                continue
            broken = broken.replace(extra[0], extra[1], 1)
        assert broken != source
        if crlf:
            broken = broken.replace("\n", "\r\n")

        io.open(full, "w", encoding="utf-8", newline="").write(broken)
        try:
            still_green, fails = run_suite()
        finally:
            io.open(full, "w", encoding="utf-8", newline="").write(original)

        if still_green:
            print(f"NOT PROVEN  {name} — the suite stayed green")
            unproven.append(name)
        else:
            print(f"caught      {name}")
            print(f"            {fails}")

    print()
    if unproven:
        print(f"{len(unproven)} of {len(BREAKS)} breaks were NOT caught:")
        for u in unproven:
            print(f"  - {u}")
        return 1
    print(f"All {len(BREAKS)} breaks were caught.")
    return 0


sys.exit(main())
