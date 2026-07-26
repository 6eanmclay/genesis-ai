import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";

// The first thing any first-time visitor (or beta invite link) lands on.
// Deliberately minimal — a real entry point (what Genesis is + how to get
// in), not a marketing site. A logged-in visitor is sent straight to their
// dashboard rather than being shown a "sign up" screen they don't need.
export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-center py-32 px-8 text-center">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          ✨ Genesis
        </p>
        <h1 className="mt-2 text-5xl font-bold tracking-tight text-black dark:text-zinc-50">
          Your AI business partner
        </h1>
        <p className="mt-6 max-w-md text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Describe your business in plain English. Genesis builds your brand,
          your products, and your storefront — ready to publish.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="rounded-full bg-foreground px-6 py-2.5 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
          >
            Get started
          </Link>
          <Link
            href="/login"
            className="rounded-full border border-black/[.08] px-6 py-2.5 text-sm font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-[#1a1a1a]"
          >
            Log in
          </Link>
        </div>
      </main>
    </div>
  );
}
