"use client";

import { useRef, useState } from "react";
import { upload as blobUpload } from "@vercel/blob/client";
import { useJ4Ask } from "../J4AskContext";

// Studio's capability board (2026-08-18).
//
// The chips were one flat list, which read as a pile of commands rather than a
// workshop. Sean: "Studio should communicate: these are the things J4 can help
// me create and work with." So they are grouped by what the merchant is trying
// to make, with a few strong ones visible and the rest behind "More".
//
// STILL NOT DESIGN OPERATIONS. Every chip sends a sentence into the same
// conversation. There is no hard-coded "make it minimal" path behind any of
// them, and there must never be — the moment a chip calls something the
// conversation cannot, Studio is a design editor with a chat box attached.
//
// UPLOAD USES THE EXISTING PATH, deliberately. The browser PUTs bytes straight
// to Blob through /api/blob/business-asset-upload and then calls the same
// uploadBusinessAssetFromChat action the conversation's own upload button
// calls, which lands in ingestBusinessAsset. No second upload route, no second
// asset system — an upload from Studio and an upload from chat produce the
// identical asset record.

export interface StudioCategory {
  key: string;
  label: string;
  /** Shown immediately. Keep this short — three or four. */
  primary: string[];
  /** Revealed by "More". */
  more: string[];
}

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/heic,image/heif";

function randomKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function extensionFor(file: File): string {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName && fromName.length <= 5) return fromName;
  return file.type.split("/")[1] ?? "png";
}

export function StudioActions({
  categories,
  uploadAsset,
  currentPath,
}: {
  categories: StudioCategory[];
  /** The same server action the conversation's upload button uses. */
  uploadAsset: (formData: FormData) => void;
  currentPath: string;
}) {
  const { ask, available } = useJ4Ask();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // What the owner said they were uploading, carried into the message so J4
  // knows whether it is a logo, a product photo or lifestyle imagery. Without
  // it every upload is "here is a file" and J4 has to guess.
  const intentRef = useRef<string>("");

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of Array.from(files)) {
        const blob = await blobUpload(`assets/${randomKey()}.${extensionFor(file)}`, file, {
          access: "public",
          handleUploadUrl: "/api/blob/business-asset-upload",
        });
        const formData = new FormData();
        formData.set("url", blob.url);
        formData.set("originalFilename", file.name);
        formData.set("contentType", file.type);
        formData.set("currentPath", currentPath);
        if (intentRef.current) formData.set("note", intentRef.current);
        await uploadAsset(formData);
      }
      // The owner's own words about what they just brought in, sent as a real
      // message so the conversation carries the intent and J4 can designate it.
      if (intentRef.current && available) ask(intentRef.current);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "That upload didn't go through.");
    } finally {
      setUploading(false);
      intentRef.current = "";
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function pickFiles(intent: string) {
    intentRef.current = intent;
    fileInputRef.current?.click();
  }

  const chipClass =
    "rounded-full border border-black/[.08] bg-white px-3.5 py-1.5 text-left text-[13px] text-zinc-700 transition hover:border-black/[.16] hover:bg-black/[.03] active:scale-[.98] disabled:opacity-50 dark:border-white/[.1] dark:bg-white/[.05] dark:text-zinc-300 dark:hover:bg-white/[.09]";

  return (
    <div className="flex flex-col gap-5">
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {categories.map((category) => {
        const isOpen = expanded === category.key;
        const shown = isOpen ? [...category.primary, ...category.more] : category.primary;
        const isUpload = category.key === "upload";
        return (
          <section key={category.key}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{category.label}</h3>
            <ul className="mt-2 flex flex-wrap gap-2">
              {shown.map((phrase) => (
                <li key={phrase}>
                  <button
                    type="button"
                    disabled={isUpload ? uploading : !available}
                    onClick={() => (isUpload ? pickFiles(phrase) : ask(phrase))}
                    className={chipClass}
                  >
                    {isUpload && uploading ? "Uploading…" : phrase}
                  </button>
                </li>
              ))}
              {category.more.length > 0 && (
                <li>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : category.key)}
                    className="rounded-full px-3 py-1.5 text-[13px] font-medium text-zinc-500 underline-offset-2 hover:underline"
                  >
                    {isOpen ? "Less" : "More…"}
                  </button>
                </li>
              )}
            </ul>
          </section>
        );
      })}

      {uploadError && <p className="text-[13px] text-red-600 dark:text-red-400">{uploadError}</p>}
    </div>
  );
}
