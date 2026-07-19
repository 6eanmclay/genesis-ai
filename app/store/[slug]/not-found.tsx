import Link from "next/link";

export default function StoreNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-8 text-center dark:bg-black">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
        This store isn&apos;t available
      </h1>
      <p className="mt-3 max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
        It may not exist, or the owner hasn&apos;t published it yet.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-full bg-foreground px-5 py-2 text-sm text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
      >
        Back to Genesis AI
      </Link>
    </div>
  );
}
