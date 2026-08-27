"use client";

import { useMemo, useRef, useState } from "react";
import {
  FRONT,
  addLayer,
  designProblem,
  emptyDesign,
  isEmpty,
  layerForAsset,
  layersOn,
  usedPlacements,
  type PlacementId,
  type ProductDesign,
} from "@/lib/creation/design";
import { areaFor, colorsOf, sizesFor, variantFor, type Garment, type BlankImage } from "@/lib/creation/garment";
import { applyOperation, describeOperation, operationsFor, type DesignOperation } from "@/lib/creation/operations";
import { CreationCanvas } from "./CreationCanvas";

// THE CREATION STATION.
//
// ============ THE PERSON IS DRIVING ======================================
//
// Every control here acts directly. Nothing waits on J4, nothing requires
// asking for permission, and the asking is an addition rather than the
// mechanism. Sean's own line: the owner should be able to experiment
// themselves, and J4 should participate without taking control away.
//
// So the instruction box below emits the SAME operations the pointer emits —
// see lib/creation/operations.ts. "Make the back graphic 20% smaller" is a
// scale by 0.8 against the same design, applied the same way, and it does not
// wait on a model to say so. What genuinely needs J4 is judgement, and that is
// a conversation rather than a control.
//
// ============ UNDO IS A STACK OF DESIGNS =================================
//
// Not a log of inverse operations. An inverse that is subtly wrong is a
// corruption nobody notices until they undo twice, and every operation here
// already returns a new design — so keeping the old one costs nothing.

interface Asset {
  id: string;
  url: string;
  name: string;
}

export function CreationStation({
  garment,
  assets,
  blankImages,
  creatableId,
  onAddToStore,
}: {
  garment: Garment;
  assets: Asset[];
  /** The supplier's transparent blanks for this product. Empty is a real answer. */
  blankImages: BlankImage[];
  /** Only used for the drawn fallback when the supplier has no blank. */
  creatableId: string;
  /** Returns null on success, or a message the owner can act on. */
  onAddToStore: (design: ProductDesign) => Promise<string | null>;
}) {
  const colors = useMemo(() => colorsOf(garment), [garment]);
  const [color, setColor] = useState(colors[0]?.color ?? "");
  const sizes = useMemo(() => sizesFor(garment, color), [garment, color]);
  const [size, setSize] = useState(sizes[0] ?? "");

  const variant = variantFor(garment, color, size);
  const [placement, setPlacement] = useState<PlacementId>(FRONT);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<ProductDesign[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [saving, setSaving] = useState(false);

  const [design, setDesign] = useState<ProductDesign>(() => emptyDesign(garment.externalProductId));

  // A COUNTER, NOT A TIMESTAMP. Date.now() is impure, and React's own rule
  // against calling it during render is right for a reason that applies here
  // even in a handler: two layers added in the same millisecond would share an
  // id, and an id collision in a keyed list is a swap nobody can explain.
  const nextLayerId = useRef(0);

  // The chosen variant travels with the design, so what is submitted is the
  // colour and size on screen rather than whatever was picked first.
  const current: ProductDesign = { ...design, externalVariantId: variant?.externalVariantId ?? null };

  const area = areaFor(garment, placement);
  const problem = designProblem(current, garment.printAreas);

  function commit(next: ProductDesign, message?: string) {
    setHistory((h) => [...h.slice(-49), design]);
    setDesign(next);
    if (message) setNote(message);
  }

  function run(op: DesignOperation) {
    commit(applyOperation(design, op));
  }

  function undo() {
    setHistory((h) => {
      if (h.length === 0) return h;
      setDesign(h[h.length - 1]);
      return h.slice(0, -1);
    });
    setNote(null);
  }

  function addArtwork(asset: Asset) {
    const image = new Image();
    image.src = asset.url;
    commit(
      addLayer(
        design,
        placement,
        layerForAsset({
          id: `${asset.id}-${nextLayerId.current++}`,
          assetUrl: asset.url,
          // Real dimensions when the browser already has them, so a wide logo
          // arrives wide rather than being squared and then fixed by hand.
          naturalWidth: image.naturalWidth || undefined,
          naturalHeight: image.naturalHeight || undefined,
          area: area ?? undefined,
        }),
      ),
      `Added ${asset.name} to the ${placement}`,
    );
  }

  function ask() {
    const ops = operationsFor(instruction, design, { activePlacement: placement, selectedLayerId: selected });
    if (!ops) {
      // HONEST ABOUT NOT UNDERSTANDING. A parser that guessed would move
      // somebody's artwork somewhere they did not ask for, which is worse
      // than saying so.
      setNote("I can move, resize, centre, flip, rotate or remove artwork. For anything else, ask J4 in chat.");
      return;
    }
    let next = design;
    for (const op of ops) next = applyOperation(next, op);
    commit(next, ops.map(describeOperation).join(". "));
    setInstruction("");
  }

  async function addToStore() {
    setSaving(true);
    try {
      const error = await onAddToStore(current);
      setNote(error ?? "Added to your store.");
    } finally {
      setSaving(false);
    }
  }

  // ============ WHICH BLANK, AND WHICH COLOUR BEHIND IT ================
  //
  // Both come from the supplier. The blank is chosen by PLACEMENT, so turning
  // the garment over shows its back rather than the same picture twice; the
  // colour is the hex Printful declares for the variant, so a colour that
  // cannot be manufactured cannot be selected.
  //
  // An image marked for a specific colour wins over a general one — Printful
  // publishes per-colour blanks for some products and one transparent blank
  // for the rest, and the per-colour version is the truer picture where it
  // exists.
  const chosenHex = colors.find((c) => c.color === color)?.colorHex ?? null;
  const blankUrl = useMemo(() => {
    const forPlacement = blankImages.filter((b) => b.placement === placement);
    const pool = forPlacement.length > 0 ? forPlacement : blankImages;
    const exact = chosenHex
      ? pool.find((b) => b.colorCode?.toLowerCase() === chosenHex.toLowerCase())
      : undefined;
    return (exact ?? pool.find((b) => b.colorCode === null) ?? pool[0])?.url ?? null;
  }, [blankImages, placement, chosenHex]);

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold text-[var(--brand-text,inherit)]">{garment.name}</h1>
        <p className="mt-1 text-[13px] text-zinc-500">
          {/* THE MANUFACTURER, WHERE THE SUPPLIER NAMED ONE. Absent rather
              than invented — see brandFromTitle. */}
          {garment.brand ? `${garment.brand} · ` : ""}
          {garment.printAreas.map((a) => a.placement).join(" and ")} printable
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          {/* FRONT AND BACK ARE SEPARATE CANVASES on the same garment. Only
              the sides this blank actually prints on are offered. */}
          <div className="mb-4 flex gap-2">
            {garment.printAreas.map((a) => {
              const count = layersOn(design, a.placement).length;
              const active = a.placement === placement;
              return (
                <button
                  key={a.placement}
                  type="button"
                  onClick={() => {
                    setPlacement(a.placement);
                    setSelected(null);
                  }}
                  className={[
                    "rounded-full px-4 py-1.5 text-[13px] capitalize transition",
                    active ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "bg-black/[.06] dark:bg-white/[.08]",
                  ].join(" ")}
                >
                  {a.placement}
                  {count > 0 && <span className="ml-1.5 opacity-60">{count}</span>}
                </button>
              );
            })}
          </div>

          <CreationCanvas
            design={design}
            placement={placement}
            area={area}
            blankUrl={blankUrl}
            colorHex={chosenHex}
            creatableId={creatableId}
            selectedLayerId={selected}
            onSelect={setSelected}
            onMove={(layerId, dx, dy) => setDesign((d) => applyOperation(d, { kind: "move", placement, layerId, dx, dy }))}
            onScale={(layerId, factor) => setDesign((d) => applyOperation(d, { kind: "scale", placement, layerId, factor }))}
          />

          {/* The controls that act on the selected artwork. Disabled rather
              than hidden, so the toolbar does not move under the pointer. */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {([
              ["Centre", () => run({ kind: "centre", placement, layerId: selected!, axis: "both" })],
              ["Bigger", () => run({ kind: "scale", placement, layerId: selected!, factor: 1.1 })],
              ["Smaller", () => run({ kind: "scale", placement, layerId: selected!, factor: 0.9 })],
              ["Flip", () => run({ kind: "flip", placement, layerId: selected!, axis: "x" })],
              ["Rotate", () => run({ kind: "rotate", placement, layerId: selected!, degrees: 90 })],
              ["Remove", () => { run({ kind: "remove", placement, layerId: selected! }); setSelected(null); }],
            ] as const).map(([label, action]) => (
              <button
                key={label}
                type="button"
                disabled={!selected}
                onClick={action}
                className="rounded-full border border-black/[.12] px-3.5 py-1.5 text-[13px] transition hover:bg-black/[.04] disabled:opacity-35 dark:border-white/[.16] dark:hover:bg-white/[.06]"
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              disabled={history.length === 0}
              onClick={undo}
              className="rounded-full border border-black/[.12] px-3.5 py-1.5 text-[13px] transition hover:bg-black/[.04] disabled:opacity-35 dark:border-white/[.16] dark:hover:bg-white/[.06]"
            >
              Undo
            </button>
          </div>

          {!selected && !isEmpty(design) && (
            <p className="mt-3 text-center text-[12px] text-zinc-500">Tap a design to move or resize it.</p>
          )}
        </div>

        <aside className="flex flex-col gap-6">
          {/* THE GARMENT'S OWN COLOURS, with the supplier's own hex. */}
          <section>
            <h2 className="text-[13px] font-medium text-zinc-500">Colour</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              {colors.map((c) => (
                <button
                  key={c.color}
                  type="button"
                  title={c.color}
                  aria-label={c.color}
                  aria-pressed={c.color === color}
                  onClick={() => {
                    setColor(c.color);
                    const next = sizesFor(garment, c.color);
                    // A COLOUR SOLD OUT IN THIS SIZE IS A REAL STATE. Keeping
                    // an unavailable size selected would submit a variant that
                    // does not exist.
                    if (!next.includes(size)) setSize(next[0] ?? "");
                  }}
                  style={{ background: c.colorHex ?? "#d4d4d8" }}
                  className={[
                    "h-8 w-8 rounded-full border transition",
                    c.color === color
                      ? "border-[var(--brand-accent,#6366f1)] ring-2 ring-[var(--brand-accent,#6366f1)]/40"
                      : "border-black/15 dark:border-white/20",
                  ].join(" ")}
                />
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-[13px] font-medium text-zinc-500">Size</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              {sizes.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={s === size}
                  onClick={() => setSize(s)}
                  className={[
                    "rounded-lg px-3 py-1.5 text-[13px] transition",
                    s === size ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "bg-black/[.06] dark:bg-white/[.08]",
                  ].join(" ")}
                >
                  {s}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-[13px] font-medium text-zinc-500">Your artwork</h2>
            {assets.length === 0 ? (
              <p className="mt-2 text-[13px] text-zinc-500">
                Nothing uploaded yet. Add a logo or a graphic in your business assets and it will appear here.
              </p>
            ) : (
              <div className="mt-2 grid grid-cols-3 gap-2">
                {assets.map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => addArtwork(asset)}
                    title={`Add ${asset.name} to the ${placement}`}
                    className="aspect-square overflow-hidden rounded-lg border border-black/[.10] bg-white p-1 transition hover:border-black/30 dark:border-white/[.14] dark:bg-zinc-900"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- Blob-hosted */}
                    <img src={asset.url} alt={asset.name} className="h-full w-full object-contain" />
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* J4, ALONGSIDE RATHER THAN IN CHARGE. Direct instructions are
              answered here and instantly; judgement is a conversation. */}
          <section>
            <h2 className="text-[13px] font-medium text-zinc-500">Ask for a change</h2>
            <div className="mt-2 flex gap-2">
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") ask();
                }}
                placeholder="Make the back graphic 20% smaller"
                className="min-w-0 flex-1 rounded-lg border border-black/[.12] bg-transparent px-3 py-2 text-[13px] dark:border-white/[.16]"
              />
              <button
                type="button"
                onClick={ask}
                className="rounded-lg bg-zinc-900 px-3 py-2 text-[13px] text-white dark:bg-white dark:text-black"
              >
                Go
              </button>
            </div>
            {note && <p className="mt-2 text-[12px] text-zinc-500">{note}</p>}
          </section>

          <section className="border-t border-black/[.08] pt-5 dark:border-white/[.12]">
            {/* ONE SOURCE FOR WHETHER THIS CAN BE MADE. The button and the
                server ask designProblem, so a disabled button and a refused
                action cannot disagree. */}
            <button
              type="button"
              disabled={problem !== null || saving}
              onClick={addToStore}
              className="w-full rounded-full bg-[var(--brand-accent,#6366f1)] px-5 py-2.5 text-[15px] font-medium text-white transition disabled:opacity-40"
            >
              {saving ? "Adding…" : "Add to my store"}
            </button>
            {problem && <p className="mt-2 text-center text-[12px] text-zinc-500">{problem}</p>}
            {!problem && (
              <p className="mt-2 text-center text-[12px] text-zinc-500">
                {usedPlacements(current).join(" and ")} · {color} · {size}
                {variant?.costInCents != null && ` · costs $${(variant.costInCents / 100).toFixed(2)}`}
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
