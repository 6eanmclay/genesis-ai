"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { attachTrackingNumber, correctTrackingNumber } from "@/app/dashboard/actions";

// ADDING A TRACKING NUMBER, BY HAND OR BY CAMERA.
//
// Two ways in, because merchants ship in two different situations. At a desk
// with the label in front of them, typing is fastest. Standing at a counter
// with a phone and a stack of parcels, scanning is the only thing that does not
// hurt.
//
// THE SCANNER IS OFFERED ONLY WHERE IT WORKS. BarcodeDetector is a real browser
// API and it is genuinely absent on iOS Safari, which is a large share of the
// phones a merchant will actually be holding. A "Scan" button that opens a
// camera and then silently never detects anything is worse than no button — the
// merchant stands there assuming they are holding it wrong. So support is
// detected first and the control simply does not appear when it is missing.
//
// Manual entry is never hidden behind the scanner. It is the path that always
// works, and the scanner fills the same box.

/** The subset of the BarcodeDetector API this uses. Not in lib.dom yet. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

/** Shipping labels are Code 128 in practice; the rest are cheap to allow. */
const LABEL_FORMATS = ["code_128", "code_39", "codabar", "itf", "data_matrix", "qr_code"];

export function AddTrackingPanel({
  orderId,
  // ============ ADDING AND CORRECTING, ONE PANEL (2026-09-01) ========
  //
  // The scanner, the validation and the carrier list are identical for both,
  // and duplicating them would mean fixing every future camera quirk twice.
  // What differs is which server action runs and what the button says — and
  // the action is the thing that carries the real difference, because
  // correcting has three refusals that adding does not.
  //
  // Defaulted to false so every existing call site keeps its exact behaviour.
  correcting = false,
  currentTrackingNumber,
}: {
  orderId: string;
  correcting?: boolean;
  currentTrackingNumber?: string | null;
}) {
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrier, setCarrier] = useState("USPS");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [canScan, setCanScan] = useState(false);
  const [isPending, startTransition] = useTransition();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);

  // Detected once, on mount. Both halves are required: the API itself, and a
  // camera to point at anything.
  //
  // Deferred to a microtask rather than set in the effect body. It cannot be a
  // lazy useState initialiser — that runs during SSR too, where `window` does
  // not exist, so the server would render "no scanner" and the client would
  // render "scanner", which is a hydration mismatch. Setting it synchronously
  // in the effect is the other obvious shape and trips the cascading-render
  // rule. One microtask later is neither.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setCanScan(
        typeof window !== "undefined" &&
          "BarcodeDetector" in window &&
          typeof navigator !== "undefined" &&
          Boolean(navigator.mediaDevices?.getUserMedia)
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The camera is released on unmount, whatever happened. A page left with a
  // live camera is a light on somebody's phone that will not go out.
  useEffect(() => {
    return () => stopCamera();
  }, []);

  function stopCamera() {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanning(false);
  }

  async function startScanning() {
    setScanError(null);
    setResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // The back camera on a phone; ignored harmlessly on a laptop.
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      setScanning(true);

      const Detector = (window as unknown as { BarcodeDetector: BarcodeDetectorConstructor })
        .BarcodeDetector;
      const detector = new Detector({ formats: LABEL_FORMATS });

      // Attached after the state flip so the <video> exists to receive it.
      requestAnimationFrame(() => {
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        void video.play();

        const tick = async () => {
          if (!videoRef.current || !streamRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            const value = found[0]?.rawValue?.trim();
            if (value) {
              // FILLS THE BOX, DOES NOT SUBMIT. A scan can pick up the wrong
              // barcode on a busy label — there are several — so the merchant
              // sees what was read and confirms it.
              setTrackingNumber(value);
              stopCamera();
              return;
            }
          } catch {
            // A single failed frame is ordinary; keep looking.
          }
          frameRef.current = requestAnimationFrame(() => void tick());
        };
        frameRef.current = requestAnimationFrame(() => void tick());
      });
    } catch {
      // Almost always a denied camera permission, and saying so is more useful
      // than a generic failure.
      setScanError("Genesis could not open the camera. Check the permission, or type the number in.");
      stopCamera();
    }
  }

  function submit() {
    setResult(null);
    startTransition(async () => {
      const outcome = correcting
        ? await correctTrackingNumber(orderId, trackingNumber, carrier)
        : await attachTrackingNumber(orderId, trackingNumber, carrier);
      setResult(
        outcome.ok ? { ok: true, text: outcome.message } : { ok: false, text: outcome.error }
      );
      if (outcome.ok) setTrackingNumber("");
    });
  }

  return (
    <div className="py-2">
      {scanning ? (
        <div className="flex flex-col gap-2">
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full max-w-sm rounded-lg border border-black/[.08] dark:border-white/[.145]"
          />
          <p className="text-xs text-zinc-500">Point the camera at the barcode on the label.</p>
          <button
            type="button"
            onClick={stopCamera}
            className="self-start rounded-full border border-black/[.08] px-4 py-1.5 text-xs dark:border-white/[.145] dark:text-zinc-50"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
              placeholder="Tracking number"
              className="min-w-[14rem] flex-1 rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
            />
            <input
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              placeholder="Carrier"
              className="w-28 rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isPending || trackingNumber.trim().length === 0}
              onClick={submit}
              className="rounded-full bg-black px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
            >
              {isPending
                ? correcting
                  ? "Correcting..."
                  : "Adding..."
                : correcting
                  ? "Replace tracking number"
                  : "Add tracking number"}
            </button>
            {/* Absent, not disabled, where the browser cannot do it — see the
                note at the top of this file. */}
            {canScan && (
              <button
                type="button"
                onClick={() => void startScanning()}
                className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs dark:border-white/[.145] dark:text-zinc-50"
              >
                Scan barcode
              </button>
            )}
          </div>
          {scanError && <p className="text-xs text-amber-700 dark:text-amber-400">{scanError}</p>}
          {result && (
            <p
              className={`text-xs ${
                result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
              }`}
            >
              {result.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
