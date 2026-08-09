import "dotenv/config";
import { prismaSystem } from "../lib/prisma";
import { editProductExecutable } from "../lib/execution/executables/products";

// Real end-to-end verification (2026-08-09) — the most important thing to
// confirm before this ships: editProductExecutable's own partial-update
// logic must NEVER silently null out a field the caller didn't intend to
// touch. A bug here would be a real, silent data-loss risk (a "just
// change the name" proposal wiping the price to null on approval) — the
// exact class of bug that only shows up by actually running the code,
// not by typecheck.
async function main() {
  const product = await prismaSystem.product.findFirst({ select: { id: true, name: true, description: true, priceInCents: true, storeId: true } });
  if (!product) throw new Error("No real product found to test against");
  console.log("Starting state:", product);

  const ctx = { storeId: product.storeId, userId: null, actorType: "USER" as const };

  // 1. Partial update — name only. description/priceInCents must survive untouched.
  const newName = `${product.name} (verify-tmp)`;
  await editProductExecutable.run({ productId: product.id, name: newName }, ctx);
  let current = await prismaSystem.product.findUniqueOrThrow({ where: { id: product.id } });
  console.log("After name-only update:", { name: current.name, description: current.description, priceInCents: current.priceInCents });
  if (current.name !== newName) throw new Error("name did not update");
  if (current.description !== product.description) throw new Error("description was touched by a name-only update — real data-loss bug");
  if (current.priceInCents !== product.priceInCents) throw new Error("priceInCents was touched by a name-only update — real data-loss bug");

  // 2. Partial update — description only. name/priceInCents must survive untouched.
  const newDescription = `${product.description ?? ""} (verify-tmp)`;
  await editProductExecutable.run({ productId: product.id, description: newDescription }, ctx);
  current = await prismaSystem.product.findUniqueOrThrow({ where: { id: product.id } });
  console.log("After description-only update:", { name: current.name, description: current.description, priceInCents: current.priceInCents });
  if (current.description !== newDescription) throw new Error("description did not update");
  if (current.name !== newName) throw new Error("name was touched by a description-only update — real data-loss bug");
  if (current.priceInCents !== product.priceInCents) throw new Error("priceInCents was touched by a description-only update — real data-loss bug");

  // Restore original state.
  await editProductExecutable.run({ productId: product.id, name: product.name, description: product.description ?? null, priceInCents: product.priceInCents }, ctx);
  const restored = await prismaSystem.product.findUniqueOrThrow({ where: { id: product.id } });
  console.log("Restored:", { name: restored.name, description: restored.description, priceInCents: restored.priceInCents });
  if (restored.name !== product.name || restored.description !== product.description || restored.priceInCents !== product.priceInCents) {
    throw new Error("cleanup failed to restore original state");
  }

  console.log("\nAll editProductExecutable partial-update assertions passed.");
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prismaSystem.$disconnect());
