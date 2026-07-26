import type { InventorySnapshot } from "@/lib/dashboard/types";

export function InventorySnapshotCard({ snapshot }: { snapshot: InventorySnapshot }) {
  return (
    <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
      <div className="flex items-baseline gap-2">
        <p className="text-2xl font-semibold text-black dark:text-zinc-50">{snapshot.activeCount}</p>
        <p className="text-sm text-zinc-500">active product{snapshot.activeCount === 1 ? "" : "s"}</p>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {snapshot.inactiveCount} hidden, {snapshot.totalCount} total
      </p>
      <p className="mt-3 text-xs text-zinc-400">Stock-quantity tracking isn&apos;t available yet.</p>
    </div>
  );
}
