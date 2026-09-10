/**
 * FINDING THE SCREENSHOT THE OWNER JUST SHOWED J4.
 *
 * ============ NO SECOND UPLOAD MECHANISM (2026-09-10) =================
 *
 * Sean: "Use the existing chat upload path only... Do not create a second
 * upload mechanism."
 *
 * So there is no upload here at all. The owner uploads a screenshot the way
 * they upload anything else - uploadChatFile -> ingestBusinessAsset -> a
 * BusinessRecord with a real storageUrl, and a StoreMessage carrying the image
 * so the conversation can show it. That path is untouched.
 *
 * What is new is only the QUESTION asked of a picture that already exists.
 * classifyAndExtractAsset asks "what business fact is this"; the reference
 * analysis asks "what design principle is this" of the same row. This module
 * is the one line between them: which row did they mean.
 *
 * ============ "THIS" MEANS THE ONE THEY JUST SHOWED ME ================
 *
 * "I like this website" is a sentence about the picture immediately above it.
 * So the referent is the most recent image the owner uploaded, and it is
 * resolved from the record's own createdAt rather than from anything the model
 * says - a model asked to name an id will eventually name one that does not
 * exist, or worse, one belonging to a different upload.
 *
 * Deliberately narrow: documents are not references, and neither is an image
 * uploaded so long ago that "this" cannot honestly mean it. Both are refused
 * with a reason the owner can act on rather than resolved to the nearest
 * candidate - the same rule the design vocabulary follows.
 */

/** How far back "this" can reach. Beyond it, J4 asks rather than guesses. */
export const RECENT_UPLOAD_WINDOW_MS = 60 * 60 * 1000;

export interface UploadedImage {
  id: string;
  storageUrl: string;
  fileType: string;
  originalFilename: string;
  createdAt: Date;
}

export type ReferentOutcome =
  | { found: true; image: UploadedImage }
  | { found: false; because: string };

/**
 * Which uploaded image the owner meant, or why J4 cannot tell.
 *
 * Pure, and separated from the query on purpose: "which one did they mean" is
 * the decision worth testing, and it needs no database to exercise.
 */
export function referentFor(
  candidates: UploadedImage[],
  now: Date,
  windowMs: number = RECENT_UPLOAD_WINDOW_MS,
): ReferentOutcome {
  const images = candidates.filter((c) => c.fileType === "image");
  if (images.length === 0) {
    return {
      found: false,
      because:
        "I can't see a screenshot to look at. Upload a picture of the site you like and I'll read its design.",
    };
  }
  const newest = images.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
  const age = now.getTime() - newest.createdAt.getTime();
  if (age > windowMs) {
    // NOT resolved to the nearest candidate. An hour-old upload is not what
    // "this" means, and reading the wrong picture would produce a confident
    // analysis of something the owner was not talking about.
    return {
      found: false,
      because:
        "The last picture you showed me was a while ago, so I'm not sure which one you mean. " +
        "Upload the screenshot again and I'll read it.",
    };
  }
  return { found: true, image: newest };
}
