"""Remove each boundary protection and watch the bad request succeed.

Sean: "I want the audit to prove that removing each important protection
actually allows the bad request through, rather than tests that merely inspect
source text."

So every break here disables a real control, and the suite must notice by
sending a real request through a real handler — not by reading a file.

    python scripts/sabotage-http-boundary.py
"""

import io, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GUARD = "lib/http/guard.ts"
LIMIT = "lib/http/rateLimit.ts"
IP = "lib/http/clientIp.ts"
REGISTER = "app/api/register/route.ts"
DIAG = "app/api/diag-client-log/route.ts"
LOGSAFE = "lib/http/logSafeText.ts"
STRIPE = "app/api/webhooks/stripe/route.ts"
PAYPAL_RETURN = "app/api/checkout/paypal/return/route.ts"

BREAKS = [
    # ---- size ----
    (
        "the declared-size check is removed",
        GUARD,
        "  if (Number.isFinite(declared) && declared > maxBytes) {",
        "  if (false) {",
    ),
    (
        "the bounded read stops bounding",
        GUARD,
        "      if (total > maxBytes) {",
        "      if (false) {",
    ),
    # ---- shape ----
    (
        "validation stops rejecting",
        GUARD,
        "    if (!parsed.success) {",
        "    if (false) {",
    ),
    (
        "an unparseable body is allowed through",
        GUARD,
        '      body = raw.length === 0 ? undefined : JSON.parse(raw);',
        '      try { body = raw.length === 0 ? undefined : JSON.parse(raw); } catch { body = {}; }',
    ),
    (
        "the rejection echoes the values it refused",
        GUARD,
        "        problem: issue.message,",
        "        problem: issue.message,\n        received: (issue as { received?: unknown }).received ?? JSON.stringify(body),",
    ),
    # ---- rate ----
    (
        "the limiter always allows",
        LIMIT,
        "  const trippedAt = counts.findIndex((count, i) => count >= buckets[i].rule.max);",
        "  const trippedAt = -1;",
    ),
    (
        "a refused attempt stops being counted",
        LIMIT,
        "  await recordAttempts(buckets.map((b) => b.bucket));",
        "  // not recorded",
    ),
    (
        "only the first rule is checked",
        LIMIT,
        "  const counts = await Promise.all(\n    buckets.map(({ rule, bucket }) =>",
        "  const counts = await Promise.all(\n    buckets.slice(0, 1).map(({ rule, bucket }) =>",
    ),
    (
        "the limiter stores what it is limiting",
        LIMIT,
        '  return createHash("sha256").update(`${kind}:${value.trim().toLowerCase()}`).digest("hex");',
        "  return `${kind}:${value}`;",
    ),
    # ---- the address ----
    (
        "the whole forwarded header becomes the caller",
        IP,
        '  const first = value.split(",")[0]?.trim();\n  return first ? first : null;',
        "  return value;",
    ),
    (
        "addresses are stored as themselves",
        IP,
        '  return createHash("sha256").update(`ip:${ip}`).digest("hex").slice(0, 32);',
        "  return ip;",
    ),
    # ---- the endpoints ----
    (
        "registration stops validating its body",
        REGISTER,
        "  if (!checked.ok) return checked.response;\n\n  const { name, email, password, ref } = checked.body;",
        "  const { name, email, password, ref } = (await request.json()) as {\n"
        "    name?: string; email: string; password: string; ref?: string;\n"
        "  };\n  void checked;",
    ),
    (
        "registration loses its rate limits",
        REGISTER,
        "    limits: (body, address) => [\n"
        '      { kind: "register:ip", value: address, max: 10 },\n'
        '      { kind: "register:email", value: body.email, max: 5 },\n'
        "    ],",
        "    limits: () => [],",
    ),
    # The rule moved to lib/http/logSafeText.ts precisely BECAUSE this break
    # could not be seen: the suite had declared its own identical copy inline,
    # so removing the route's rule changed nothing it was looking at.
    (
        "the log-safety rule stops rejecting newlines",
        LOGSAFE,
        '    .regex(/^[\\w.:@ -]+$/, "unexpected characters");',
        "    ;",
    ),
    (
        "the diagnostic endpoint stops using the shared rule",
        DIAG,
        "  requestId: logSafeText(64),",
        "  requestId: z.string(),",
    ),
    # ---- the callbacks ----
    (
        "the callback token rule stops rejecting anything",
        GUARD,
        '  return z.string().min(1).max(max).regex(/^[\\w\\-.:~+/=%|]+$/, "unexpected characters");',
        "  return z.string();",
    ),
    (
        "the query validator always accepts",
        GUARD,
        "  if (parsed.success) return { ok: true, value: parsed.data };",
        "  return { ok: true, value: parsed.data as T };",
    ),
    (
        "the PayPal return stops validating its query",
        PAYPAL_RETURN,
        '  if (!checked.ok) {\n    return NextResponse.redirect(new URL("/", request.url));\n  }\n  const { token, slug } = checked.value;',
        '  const token = request.nextUrl.searchParams.get("token")!;\n  const slug = request.nextUrl.searchParams.get("slug")!;\n  void checked;',
    ),
    # ---- an exception is violated ----
    (
        "somebody rate limits the Stripe webhook",
        STRIPE,
        "export async function POST(request: Request): Promise<Response> {",
        "export async function POST(request: Request): Promise<Response> {\n"
        "  void checkRateLimit;",
    ),
]


def run_suite() -> tuple[bool, str]:
    out = os.path.join(tempfile.gettempdir(), "sabotage-hb.txt")
    subprocess.run(
        ["powershell", "-NoProfile", "-File", "scripts/run-unelevated.ps1",
         "-Command", "npx --yes tsx scripts/run-db-suites.ts http-boundary-db",
         "-OutFile", out],
        cwd=ROOT, capture_output=True,
    )
    try:
        text = io.open(out, encoding="utf-16-le", errors="replace").read()
    except OSError:
        return False, ""
    green = "0 failed," in text and "1/1 database-backed suites pass." in text
    fails = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("FAIL ")]
    return green, " | ".join(fails[:3]).encode("ascii", "replace").decode("ascii")


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
