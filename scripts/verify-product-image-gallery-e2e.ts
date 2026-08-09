import "dotenv/config";
import { prismaSystem } from "../lib/prisma";
import {
  addProductImagesExecutable,
  reorderProductImagesExecutable,
  deleteProductImageExecutable,
  replaceProductImageExecutable,
} from "../lib/execution/executables/productImages";

// Real end-to-end verification (2026-08-08) — "verify the complete
// persistence/rendering path" (Sean), not just that an upload succeeds.
// Exercises every gallery executable directly against real test data
// (the "DESKTOP Test Product" row), asserting Product.imageUrl stays
// correctly synced to the ProductImage table's own position-0 row after
// each mutation. Cleans up after itself, restoring original state.
async function main() {
  const product = await prismaSystem.product.findFirst({
    where: { name: "DESKTOP Test Product" },
    include: { images: true },
  });
  if (!product) throw new Error("Test product not found");
  const ctx = { storeId: product.storeId, userId: null, actorType: "USER" as const };
  const originalImageUrl = product.imageUrl;
  const originalImages = product.images.map((i) => i.url);
  console.log("Starting state:", { imageUrl: originalImageUrl, images: originalImages });

  // 1. Add two more images.
  await addProductImagesExecutable.run(
    { productId: product.id, urls: ["https://example.test/gallery-a.png", "https://example.test/gallery-b.png"] },
    ctx
  );
  let current = await prismaSystem.product.findUniqueOrThrow({ where: { id: product.id }, include: { images: { orderBy: { position: "asc" } } } });
  console.log("After add:", current.imageUrl, current.images.map((i) => `${i.position}:${i.url}`));
  if (current.images.length !== originalImages.length + 2) throw new Error("add: wrong image count");
  if (current.imageUrl !== originalImageUrl) throw new Error("add: primary should not have changed (product already had an image)");

  // 2. Reorder — move the last image to the front, confirm it becomes primary.
  const newOrder = [current.images[2].id, current.images[0].id, current.images[1].id];
  await reorderProductImagesExecutable.run({ productId: product.id, orderedImageIds: newOrder }, ctx);
  current = await prismaSystem.product.findUniqueOrThrow({ where: { id: product.id }, include: { images: { orderBy: { position: "asc" } } } });
  console.log("After reorder:", current.imageUrl, current.images.map((i) => `${i.position}:${i.url}`));
  if (current.imageUrl !== "https://example.test/gallery-b.png") throw new Error("reorder: primary did not update to the new position-0 image");

  // 3. Replace the (now-primary) first image, confirm Product.imageUrl follows it.
  const primaryImageId = current.images[0].id;
  await replaceProductImageExecutable.run({ imageId: primaryImageId, url: "https://example.test/gallery-replaced.png" }, ctx);
  current = await prismaSystem.product.findUniqueOrThrow({ where: { id: product.id }, include: { images: { orderBy: { position: "asc" } } } });
  console.log("After replace:", current.imageUrl, current.images.map((i) => `${i.position}:${i.url}`));
  if (current.imageUrl !== "https://example.test/gallery-replaced.png") throw new Error("replace: Product.imageUrl did not follow the replaced primary");

  // 4. Delete the (replaced) primary, confirm the next image is promoted and positions compact.
  await deleteProductImageExecutable.run({ imageId: primaryImageId }, ctx);
  current = await prismaSystem.product.findUniqueOrThrow({ where: { id: product.id }, include: { images: { orderBy: { position: "asc" } } } });
  console.log("After delete:", current.imageUrl, current.images.map((i) => `${i.position}:${i.url}`));
  if (current.images.some((img, i) => img.position !== i)) throw new Error("delete: positions did not compact to 0..n-1");
  if (current.imageUrl !== current.images[0]?.url) throw new Error("delete: Product.imageUrl did not follow the newly-promoted primary");

  // Cleanup — delete every image this script added, restoring the original single image.
  for (const img of current.images) {
    if (!originalImages.includes(img.url)) {
      await deleteProductImageExecutable.run({ imageId: img.id }, ctx);
    }
  }
  const restored = await prismaSystem.product.findUniqueOrThrow({ where: { id: product.id }, include: { images: true } });
  console.log("Restored state:", restored.imageUrl, restored.images.map((i) => i.url));
  if (restored.imageUrl !== originalImageUrl) throw new Error("cleanup: did not restore original primary");

  console.log("\nAll gallery executable assertions passed.");
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prismaSystem.$disconnect());
