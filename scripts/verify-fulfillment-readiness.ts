import { readFileSync } from "fs";
import { join } from "path";

// A PAID ORDER NEVER GOES QUIET ABOUT WHY IT CANNOT SHIP:
//
//   npx tsx scripts/verify-fulfillment-readiness.ts
//
// Standalone — this is source-level, about what the Orders screen renders in a
// state the database cannot easily be put into on demand. No database, no
// server, no provider account.
//
// THE DEFECT. `canBuyLabel` gates the Buy Label form, and when it was false the
// form simply did not render. An owner looking at a paid order with a real
// delivery address saw no way to ship it and no reason given. That is the R1
// defect inverted: there, J4 said what to do and offered no way to do it; here
// there was no way to do it and nothing said at all.
//
// In production this is not hypothetical — all 8 published stores have no
// ship-from address, so `canBuyLabel` is false for every one of them.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const read = (...p: string[]) => codeOnly(readFileSync(join(process.cwd(), ...p), "utf8"));

const list = read("app", "dashboard", "OrdersList.tsx");
const workspace = read("app", "dashboard", "orders", "OrdersWorkspace.tsx");

console.log("\n=== The reason exists, and is specific ===\n");

assert("the workspace names why a label cannot be bought",
  /labelBlockedBy[\s\S]{0,200}"return_address"[\s\S]{0,80}"shipping_provider"/.test(workspace),
  "one opaque boolean cannot say which of two different problems to fix");
assert("a missing ship-from address is distinguished from a missing provider",
  /!returnAddress\s*\?\s*"return_address"/.test(workspace),
  "they have different remedies, so they are not collapsed into one message");
assert("and it is null when nothing is wrong",
  /labelBlockedBy[^=]*=\s*canBuyLabel\s*\n?\s*\?\s*null/.test(workspace));

console.log("\n=== The order says it ===\n");

assert("a blocked order renders an explanation",
  /!canBuyLabel && order\.shippingAddress && !order\.trackingNumber/.test(list),
  "this branch used to render nothing at all");
assert("the ship-from case tells the owner what to add",
  /Add your ship-from address/.test(list));
assert("the provider case says shipping is not connected",
  /Shipping isn't connected yet/.test(list));

// SHOWN ONLY WHERE A BUTTON WOULD OTHERWISE HAVE BEEN. An order with no
// delivery address, or one already shipped, must not carry an explanation for
// a button it was never going to have.
assert("it is not shown for an order with no delivery address",
  /!canBuyLabel && order\.shippingAddress/.test(list),
  "an order nobody can ship anyway needs no shipping explanation");
assert("nor for one that already has tracking",
  /!canBuyLabel[\s\S]{0,60}!order\.trackingNumber/.test(list));

console.log("\n=== CONTROL: the working path is untouched ===\n");

// UPDATED 2026-09-02. The condition gained `order.shippedBy === "OWNER"`,
// deliberately: buying postage for a partner-fulfilled order would produce
// a label for a box in somebody else's warehouse. That is a STRONGER
// guarantee than this assertion was written against, so the new clause is
// pinned rather than the assertion loosened to accommodate it.
assert("the Buy Label form still renders when it can, and only for an order the owner ships",
  /canManage && order\.shippedBy === "OWNER" && canBuyLabel && order\.shippingAddress && !order\.trackingNumber && \(\s*<BuyLabelForm/.test(list));
assert("and canBuyLabel still requires a working provider AND an address",
  /canBuyLabel = Boolean\(uspsWorking && returnAddress\)/.test(workspace),
  "this milestone explains the blocked state; it does not loosen it");

console.log("\n=== The parcel is not retyped ===\n");

// Product has carried weightOz/lengthIn/widthIn/heightIn since 2026-08-20, and
// the label form asked for the weight on every order anyway. The executable and
// the server action both already accepted all four; only the form never offered
// them and nothing ever filled them in.
// UPDATED 2026-09-02. The select was reformatted across several lines and
// gained sourceKind; all four parcel fields are still read. Asserted field
// by field so it survives formatting but still fails if any one of them
// stops being selected — which is the property that matters, since a
// missing dimension is silently un-prefillable.
assert("the order query reads the product's parcel",
  /product: \{\s*select: \{/.test(workspace) &&
    ["weightOz", "lengthIn", "widthIn", "heightIn"].every((f) =>
      new RegExp(f + ": true").test(workspace)),
  "otherwise there is nothing to pre-fill from");

for (const field of ["weightOz", "lengthIn", "widthIn", "heightIn"]) {
  assert(`${field} is pre-filled from the product`,
    new RegExp(`name="${field}"[\\s\\S]{0,180}defaultValue=\\{parcel\\.${field}`).test(list));
}

assert("every field stays editable",
  !/readOnly|disabled=\{true\}/.test(list),
  "a parcel is the product plus its packaging, and only the merchant knows what they used");

assert("where the numbers came from is stated",
  /From this product's saved weight and size/.test(list),
  "pre-filled numbers an owner did not type are worth a sentence — a wrong product " +
    "weight otherwise becomes a wrong postage purchase nobody looked at");
assert("and a product with no saved weight says so",
  /This product has no saved weight/.test(list),
  "the merchant needs to know why the box is empty");

console.log("\n=== Buying the label is the primary path, entering tracking the fallback ===\n");

const detail = read("app", "dashboard", "orders", "OrderDetail.tsx");
// TIED TO ITS CONDITION, not merely present. Checking for <BuyLabelForm/>
// anywhere was green with the gate replaced by `false` — the component was
// still in the source, in a branch that could never render.
assert("the order record offers Buy shipping label when it can",
  /\{canBuyLabel \? \([\s\S]{0,400}<BuyLabelForm/.test(detail));
assert("gated on a working connection AND both addresses",
  /shipping\?\.status === "CONNECTED" && returnAddress && order\.shippingAddress/.test(detail),
  "this spends real postage, so it is strict for the same reason canBuyLabel is");
assert("and says which of those is missing when it cannot",
  /Add your ship-from address on the Orders page/.test(detail) &&
    /Shipping isn't connected yet/.test(detail));
// UPDATED 2026-09-02, and the guarantee is unchanged — the assertion was
// comparing against the wrong element. OrderDetail now renders
// AddTrackingPanel TWICE: once with `correcting` for an order that already
// has a number, in a different branch entirely, and once as the fallback
// under the Buy Label form. indexOf found the correction panel first and
// reported the fallback as being above the primary path, which it is not.
//
// Compared against the FALLBACK usage specifically, so the ordering
// property is still pinned and a real regression still fails it.
const fallbackPanel = detail.indexOf("<AddTrackingPanel orderId={order.id} />");
assert("manual tracking is offered as the fallback, below it",
  fallbackPanel > 0 && detail.indexOf("<BuyLabelForm") < fallbackPanel,
  "order on the page says which is primary without a word of explanation");
assert("and is introduced as such",
  /Already bought postage elsewhere/.test(detail));

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
