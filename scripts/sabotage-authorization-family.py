"""Pull the authorization family apart, one drift at a time.

A suite that passed 79 assertions on its first run has not been shown to
discriminate. These are the drifts it exists to catch: a role quietly widened, a
shared decision bypassed, a refusal that stops being recorded, a wrapper that
grows its own rule, a second copy of a table.

Every break asserts its anchor applied first.

    python scripts/sabotage-authorization-family.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PERMS = "lib/permissions.ts"
CONTEXT = "lib/businessContext.ts"
ADMIN = "lib/platformAdmin.ts"

BREAKS = [
    (
        "an EMPLOYEE is quietly given the money permission",
        PERMS,
        "  EMPLOYEE: [\n    PERMISSIONS.PRODUCTS_MANAGE,",
        "  EMPLOYEE: [\n    PERMISSIONS.PAYMENTS_MANAGE,\n    PERMISSIONS.PRODUCTS_MANAGE,",
    ),
    (
        "hasPermission stops consulting the table",
        PERMS,
        "export function hasPermission(role: StoreRole, permission: Permission): boolean {\n"
        "  return ROLE_PERMISSIONS[role].includes(permission);",
        "export function hasPermission(role: StoreRole, permission: Permission): boolean {\n"
        "  return true;",
    ),
    (
        "a named business is returned without checking access",
        CONTEXT,
        "    const access = await accessTo(userId, requestedStoreId);",
        "    const access = await accessTo(userId, requestedStoreId)\n"
        "      ?? { store: (await prisma.store.findUnique({ where: { id: requestedStoreId } }))!, role: \"OWNER\" as const };",
    ),
    (
        "requireBusinessPage stops recording an unreachable business",
        PERMS,
        "  const access = await accessTo(userId, store.id);\n"
        "  if (!access) {\n"
        "    // REACHING A REAL BUSINESS THAT IS NOT YOURS.",
        "  const access = await accessTo(userId, store.id);\n"
        "  if (!access) notFound();\n"
        "  if (false) {\n"
        "    // REACHING A REAL BUSINESS THAT IS NOT YOURS.",
    ),
    (
        "requireStorePageAccess records its refusal after redirecting",
        PERMS,
        '    await recordSignal({\n'
        '      kind: SIGNAL_KINDS.authzDenied,\n'
        '      severity: "warning",\n'
        '      actorKind: "user",\n'
        '      actorId: session.user.id,\n'
        '      storeId: resolution.store.id,\n'
        '      surface: `requireStorePageAccess:${permission}`,\n'
        '      detail: { permission, role: resolution.role },\n'
        '    });\n'
        '    redirect("/dashboard");',
        '    redirect("/dashboard");\n'
        '    await recordSignal({\n'
        '      kind: SIGNAL_KINDS.authzDenied,\n'
        '      severity: "warning",\n'
        '      actorKind: "user",\n'
        '      actorId: session.user.id,\n'
        '      storeId: resolution.store.id,\n'
        '      surface: `requireStorePageAccess:${permission}`,\n'
        '      detail: { permission, role: resolution.role },\n'
        '    });',
    ),
    (
        "a migration wrapper grows a rule of its own",
        PERMS,
        "  return slug ? requireBusiness(permission, slug) : requireStorePermission(permission);",
        "  const session = await auth();\n"
        "  if (!session?.user) redirect(\"/login\");\n"
        "  return slug ? requireBusiness(permission, slug) : requireStorePermission(permission);",
    ),
    (
        "requireBusinessPage reads the business before knowing who is asking",
        PERMS,
        "export async function requireBusinessPage(\n"
        "  permission: Permission | null,\n"
        "  slug: string\n"
        "): Promise<{ userId: string; userName: string | null; store: Store; role: StoreRole }> {\n"
        "  const session = await auth();",
        "export async function requireBusinessPage(\n"
        "  permission: Permission | null,\n"
        "  slug: string\n"
        "): Promise<{ userId: string; userName: string | null; store: Store; role: StoreRole }> {\n"
        "  await prisma.store.findUnique({ where: { slug } });\n"
        "  const session = await auth();",
    ),
    (
        "a second reader of the platform-admin allowlist comes back",
        ADMIN,
        "export async function isPlatformAdmin(): Promise<boolean> {",
        "function platformAdminEmails(): Set<string> {\n"
        '  const raw = process.env.PLATFORM_ADMIN_EMAILS ?? "";\n'
        '  return new Set(raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));\n'
        "}\n"
        "void platformAdminEmails;\n\n"
        "export async function isPlatformAdmin(): Promise<boolean> {",
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-af.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts authorization-family-db",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        text = io.open(out, encoding="utf-16-le", errors="replace").read()
    except OSError:
        return False, ""
    green = "0 failed," in text and "1/1 database-backed suites pass." in text
    fails = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("FAIL ")]
    joined = " | ".join(fails[:4])
    return green, joined.encode("ascii", "replace").decode("ascii")


def main() -> int:
    print("Confirming the suite is green before breaking anything...")
    green, _ = run_suite()
    if not green:
        print("ABORT - not green to begin with. Nothing below would mean anything.")
        return 1
    print("  green.\n")

    unproven = []
    for name, path, old, new in BREAKS:
        full = os.path.join(ROOT, path)
        original = io.open(full, encoding="utf-8", newline="").read()
        crlf = "\r\n" in original
        source = original.replace("\r\n", "\n")

        if old not in source:
            print(f"BROKEN SABOTAGE  {name} - anchor not found in {path}")
            unproven.append(f"{name} (anchor missing)")
            continue
        broken = source.replace(old, new, 1)
        assert broken != source
        if crlf:
            broken = broken.replace("\n", "\r\n")

        io.open(full, "w", encoding="utf-8", newline="").write(broken)
        try:
            still_green, fails = run_suite()
        finally:
            io.open(full, "w", encoding="utf-8", newline="").write(original)

        if still_green:
            print(f"NOT PROVEN  {name} - the suite stayed green")
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
