import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createCheckoutSession } from "./actions";
import { SubmitButton } from "@/app/dashboard/SubmitButton";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  const store = await prisma.store.findUnique({
    where: { slug },
    select: { name: true, published: true },
  });

  if (!store || !store.published) {
    return { title: "Store not found" };
  }

  return { title: store.name };
}

export default async function StorefrontPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const store = await prisma.store.findUnique({
    where: { slug },
  });

  if (!store || !store.published) {
    notFound();
  }

  const products = await prisma.product.findMany({
    where: { storeId: store.id, active: true },
    orderBy: { position: "asc" },
  });

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <header className="border-b border-black/[.08] px-8 py-16 text-center dark:border-white/[.145]">
        <h1 className="text-4xl font-bold tracking-tight text-black dark:text-zinc-50">
          {store.name}
        </h1>
        {store.description && (
          <p className="mx-auto mt-3 max-w-xl text-zinc-600 dark:text-zinc-400">
            {store.description}
          </p>
        )}
      </header>

      <main className="mx-auto max-w-5xl px-8 py-12">
        {products.length === 0 ? (
          <p className="text-center text-zinc-600 dark:text-zinc-400">
            No products available yet.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <li
                key={product.id}
                className="group overflow-hidden rounded-2xl border border-black/[.08] bg-white shadow-sm transition-shadow hover:shadow-md dark:border-white/[.145] dark:bg-zinc-900"
              >
                <div className="aspect-square w-full overflow-hidden bg-zinc-100 dark:bg-zinc-800">
                  {product.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={product.imageUrl}
                      alt={product.name}
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-sm text-zinc-400 dark:text-zinc-600">
                      No image
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <h2 className="font-semibold text-black dark:text-zinc-50">
                    {product.name}
                  </h2>
                  {product.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">
                      {product.description}
                    </p>
                  )}
                  <p className="mt-3 text-lg font-semibold text-black dark:text-zinc-50">
                    ${(product.priceInCents / 100).toFixed(2)}
                  </p>
                  <form
                    action={createCheckoutSession.bind(
                      null,
                      slug,
                      product.id
                    )}
                    className="mt-3"
                  >
                    <SubmitButton
                      pendingText="Redirecting to checkout..."
                      className="w-full rounded-full bg-foreground px-4 py-2 text-sm text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
                    >
                      Buy Now
                    </SubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
