"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { addAssetToLibrary, removeAssetFromLibrary } from "./actions";
import type { LibraryAsset } from "@/lib/creation/assetLibrary";

// ADD — THE OWNER'S CREATIVE TOOLBOX.
//
// ============ NOT A FILE MANAGER (2026-08-28) ==========================
//
// Sean: "I don't want a complicated file manager... Creation Station should
// feel like their creative toolbox, not like they're browsing everything J4 has
// ever remembered."
//
// So: one way in at the top, then the things they have. No folders, no search,
// no metadata columns. Remove is present but quiet — it is tidying, not an
// operation anybody came here to perform.
//
// ============ WHAT REMOVE ACTUALLY DOES ================================
//
// It takes the asset out of THIS list. J4 keeps knowing about it, because the
// record is the same one J4 remembers and only one field changes. The copy
// says so, because a control labelled with a bin is a promise about deletion
// that this one does not keep — and would be the wrong promise to keep.

export function AddAssetPanel({
  slug,
  assets,
  onAdd,
  onGarment,
}: {
  slug: string;
  assets: LibraryAsset[];
  onAdd: (asset: { id: string; url: string; name: string }) => void;
  /** Which assets are already on the side of the garment being designed. */
  onGarment: (url: string) => boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);

  async function handleFile(file: File) {
    setBusy(true);
    setNote(null);
    try {
      // Straight to Blob, then the record. The same two-step every other
      // upload in Genesis uses — a Server Action body would cap this at a size
      // real artwork exceeds.
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/blob/business-asset-upload",
      });
      const result = await addAssetToLibrary(slug, {
        url: blob.url,
        originalFilename: file.name,
        contentType: file.type,
      });
      setNote(result.ok ? null : (result.error ?? "That upload could not be saved."));
    } catch {
      setNote("That upload did not finish. Try again.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* THE WAY IN, FIRST. Somebody opening Add with their own logo on their
          phone should not have to look for this. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          className="rounded-full bg-zinc-900 px-4 py-2 text-[13px] font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-black"
        >
          {busy ? "Uploading…" : "Upload from device"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        {assets.length > 0 && (
          <button
            type="button"
            onClick={() => setManaging((m) => !m)}
            className="ml-auto rounded-full px-3 py-2 text-[12px] text-zinc-500 transition hover:bg-black/[.05] dark:hover:bg-white/[.08]"
          >
            {managing ? "Done" : "Manage"}
          </button>
        )}
      </div>

      {note && <p className="text-[12px] text-amber-600 dark:text-amber-400">{note}</p>}

      {assets.length === 0 ? (
        <p className="text-[13px] text-zinc-500">
          Nothing here yet. Upload a logo or a graphic, or add one through J4 — anything either of
          you makes shows up here.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {assets.map((asset) => {
              const used = onGarment(asset.url);
              return (
                <div key={asset.id} className="relative">
                  <button
                    type="button"
                    onClick={() => onAdd(asset)}
                    title={asset.name}
                    className={[
                      "relative block aspect-square w-full overflow-hidden rounded-lg border bg-white p-1 transition dark:bg-zinc-900",
                      used
                        ? "border-[var(--brand-accent,#6366f1)] ring-2 ring-[var(--brand-accent,#6366f1)]/40"
                        : "border-black/[.10] hover:border-black/30 dark:border-white/[.14]",
                    ].join(" ")}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- Blob-hosted */}
                    <img src={asset.url} alt={asset.name} className="h-full w-full object-contain" />
                    {used && (
                      <span
                        aria-hidden="true"
                        className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-[var(--brand-accent,#6366f1)] text-[10px] font-semibold text-white"
                      >
                        ✓
                      </span>
                    )}
                  </button>

                  {/* ONLY WHILE MANAGING. A remove control on every tile turns a
                      toolbox into a file manager, and makes the common action
                      — picking something — sit next to a destructive-looking
                      one. */}
                  {managing && (
                    <button
                      type="button"
                      disabled={busy}
                      title={`Remove ${asset.name} from Creation Station`}
                      onClick={async () => {
                        setBusy(true);
                        const result = await removeAssetFromLibrary(slug, asset.id);
                        if (!result.ok) setNote(result.error ?? "That could not be removed.");
                        setBusy(false);
                      }}
                      className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-zinc-900/90 text-[11px] text-white shadow disabled:opacity-40 dark:bg-white/90 dark:text-black"
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {managing && (
            <p className="text-[12px] text-zinc-500">
              Removing takes it out of Creation Station. J4 still remembers it for the business, and
              nothing is deleted.
            </p>
          )}
        </>
      )}
    </div>
  );
}
