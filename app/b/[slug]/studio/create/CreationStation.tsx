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
import {
  areaFor,
  colorsOf,
  blankFor,
  designableViews,
  formatCents,
  spinViews,
  productLabel,
  sizesFor,
  variantFor,
  type Garment,
  type BlankImage,
} from "@/lib/creation/garment";
import { applyOperation, describeOperation, operationsFor, type DesignOperation } from "@/lib/creation/operations";
import { CreationCanvas } from "./CreationCanvas";
import { DesignToolbar, ToolIcons } from "./DesignToolbar";

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
  blankProblem,
  supplierPrices,
  creatableId,
  onAddToStore,
}: {
  garment: Garment;
  assets: Asset[];
  /** The supplier's transparent blanks for this product. Empty is a real answer. */
  blankImages: BlankImage[];
  /** Set when the blanks could not be read — which is NOT the same as none. */
  blankProblem: string | null;
  /** What the supplier charges, in cents, keyed by external variant id. */
  supplierPrices: Record<string, number>;
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
  // How far inside the printable area artwork is kept. See padPanel.
  const [safeMargin, setSafeMargin] = useState(0.04);
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

  // WHAT THIS EXACT VARIANT COSTS FROM THE SUPPLIER. Null when Printful did
  // not price it — said plainly rather than filled in, which is the whole
  // reason every product used to read $75.
  // ============ SPIN: TURNING THE PRODUCT, NOT THE ARTWORK ===========
  //
  // The views are the ones the supplier actually photographed. Two for a
  // hoodie today. Advancing wraps, so it turns rather than stopping at the
  // back, and it moves the DESIGN placement with it — turning the garment
  // round should show you the back you have been designing on, not a
  // disconnected picture.
  const views = useMemo(() => spinViews(garment, blankImages), [garment, blankImages]);
  const [turning, setTurning] = useState(false);

  function spin() {
    if (views.length < 2) return;
    const next = views[(Math.max(views.indexOf(placement), 0) + 1) % views.length];
    // The half-turn is presentation; the state change is instant underneath.
    setTurning(true);
    window.setTimeout(() => setTurning(false), 380);
    setPlacement(next as PlacementId);
    setSelected(null);
  }

  const supplierCost =
    (variant?.externalVariantId ? supplierPrices[variant.externalVariantId] : undefined) ?? null;
  const blank = useMemo(
    () => blankFor(blankImages, placement, chosenHex),
    [blankImages, placement, chosenHex],
  );

  // ============ WHAT EACH TOOL OPENS ==================================
  //
  // Built here rather than inside DesignToolbar so the toolbar stays a
  // presentational thing that knows nothing about garments — and so every one
  // of these is visibly the SAME control that already worked, moved.

  const colorPanel = (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-2 text-[12px] text-zinc-500">
          {colors.length} colour{colors.length === 1 ? "" : "s"} your supplier makes this in
        </p>
        <div className="flex flex-wrap gap-2">
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
                // A COLOUR SOLD OUT IN THIS SIZE IS A REAL STATE. Keeping an
                // unavailable size selected would submit a variant that does
                // not exist.
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
        <p className="mt-2 text-[12px] text-zinc-500">{color}</p>
      </div>

      <div>
        <p className="mb-2 text-[12px] text-zinc-500">Size</p>
        <div className="flex flex-wrap gap-2">
          {sizes.map((sz) => (
            <button
              key={sz}
              type="button"
              aria-pressed={sz === size}
              onClick={() => setSize(sz)}
              className={[
                "rounded-lg px-3 py-1.5 text-[13px] transition",
                sz === size ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "bg-black/[.06] dark:bg-white/[.08]",
              ].join(" ")}
            >
              {sz}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  const addPanel =
    assets.length === 0 ? (
      <p className="text-[13px] text-zinc-500">
        Nothing uploaded yet. Add a logo or a graphic in your business assets and it will appear here.
      </p>
    ) : (
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {assets.map((asset) => {
          // ALREADY ON THIS SIDE OF THE GARMENT. Without this the panel gave no
          // sign that a tap had done anything — and because the panel covers
          // the canvas, the artwork it had just added was not visible either.
          // Two silences on top of each other read as a dead control.
          const onGarment = layersOn(design, placement).some((l) => l.assetUrl === asset.url);
          return (
            <button
              key={asset.id}
              type="button"
              onClick={() => addArtwork(asset)}
              title={`Add ${asset.name} to the ${placement}`}
              className={[
                "relative aspect-square overflow-hidden rounded-lg border bg-white p-1 transition dark:bg-zinc-900",
                onGarment
                  ? "border-[var(--brand-accent,#6366f1)] ring-2 ring-[var(--brand-accent,#6366f1)]/40"
                  : "border-black/[.10] hover:border-black/30 dark:border-white/[.14]",
              ].join(" ")}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- Blob-hosted */}
              <img src={asset.url} alt={asset.name} className="h-full w-full object-contain" />
              {onGarment && (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-[var(--brand-accent,#6366f1)] text-[10px] font-semibold text-white"
                >
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>
    );

  // ============ PAD: THE MARGIN INSIDE THE PRINT AREA =================
  //
  // Sean asked for Pad to exist as its own tool and left its behaviour to be
  // defined here. It is a SAFE MARGIN: how far inside the supplier's printable
  // rectangle the artwork is kept.
  //
  // That is a real manufacturing concern rather than an invented one —
  // printers cut and press with tolerance, and artwork pushed flush to the
  // edge of a print area is the artwork that comes back trimmed. It is also
  // the only spacing idea on this screen that belongs to the PRODUCT rather
  // than to a layout.
  const padPanel = (
    <div>
      <p className="text-[13px] text-zinc-500">
        Keep artwork this far inside the printable area. A design pressed flush to the
        edge is the one that comes back trimmed.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {([
          ["None", 0],
          ["Small", 0.04],
          ["Comfortable", 0.08],
        ] as const).map(([label, value]) => (
          <button
            key={label}
            type="button"
            aria-pressed={safeMargin === value}
            onClick={() => setSafeMargin(value)}
            className={[
              "rounded-lg px-3 py-1.5 text-[13px] transition",
              safeMargin === value ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "bg-black/[.06] dark:bg-white/[.08]",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  const editPanel = (
    <div className="flex flex-wrap gap-2">
      {([
        ["Centre", () => run({ kind: "centre", placement, layerId: selected!, axis: "both" })],
        ["Bigger", () => run({ kind: "scale", placement, layerId: selected!, factor: 1.1 })],
        ["Smaller", () => run({ kind: "scale", placement, layerId: selected!, factor: 0.9 })],
        ["Rotate", () => run({ kind: "rotate", placement, layerId: selected!, degrees: 90 })],
        ["Remove", () => { run({ kind: "remove", placement, layerId: selected! }); setSelected(null); }],
        ["Undo", undo],
      ] as const).map(([label, action]) => (
        <button
          key={label}
          type="button"
          disabled={label === "Undo" ? history.length === 0 : !selected}
          onClick={action}
          className="rounded-full border border-black/[.12] px-3.5 py-1.5 text-[13px] transition hover:bg-black/[.04] disabled:opacity-35 dark:border-white/[.16] dark:hover:bg-white/[.06]"
        >
          {label}
        </button>
      ))}
    </div>
  );

  const flipPanel = (
    <div className="flex flex-wrap gap-2">
      {([
        ["Flip across", "x"],
        ["Flip over", "y"],
      ] as const).map(([label, axis]) => (
        <button
          key={axis}
          type="button"
          disabled={!selected}
          onClick={() => run({ kind: "flip", placement, layerId: selected!, axis })}
          className="rounded-full border border-black/[.12] px-3.5 py-1.5 text-[13px] transition hover:bg-black/[.04] disabled:opacity-35 dark:border-white/[.16] dark:hover:bg-white/[.06]"
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    // ROOM FOR THE TOOLBAR (2026-08-27). It is sticky at the bottom with a
    // z-index, so without this it sits ON TOP of whatever the page ends with —
    // which on a phone is "Ask for a change" and the add-to-store button. Sean
    // could type an instruction and not reach Go, because Go was underneath
    // the tool row.
    <div className="mx-auto w-full max-w-6xl px-5 pb-40 pt-8">
      {/* ============ WHAT A PERSON IS LOOKING AT =======================
          The supplier's catalogue title and its list of internal placement
          keys used to be printed here verbatim. Both are still carried in the
          data; neither belongs on the screen of somebody making a hoodie. */}
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold text-[var(--brand-text,inherit)]">
          {productLabel(garment.name)}
        </h1>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[13px] text-zinc-500">
          {/* WHAT THE SUPPLIER CHARGES, which is not what this will sell for.
              Two different numbers about two different transactions, and the
              screen showed neither until now. */}
          {supplierCost !== null ? (
            <span className="text-[15px] font-medium text-[var(--brand-text,inherit)]">
              {formatCents(supplierCost)}
            </span>
          ) : null}
          {supplierCost !== null ? <span aria-hidden="true">·</span> : null}
          <span>{supplierCost !== null ? "supplier price" : "supplier price unavailable"}</span>
          {/* THE MANUFACTURER, WHERE THE SUPPLIER NAMED ONE. Absent rather
              than invented — see brandFromTitle. Its own fact now, rather than
              punctuation inside a title. */}
          {garment.brand ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{garment.brand}</span>
            </>
          ) : null}
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          {/* FRONT AND BACK ARE SEPARATE CANVASES on the same garment. Only
              the sides this blank actually prints on are offered. */}
          <div className="mb-4 flex gap-2">
            {/* FRONT AND BACK, NAMED IN ENGLISH. Every other placement this
                blank supports stays in printAreas, where the print-area
                validation and the eventual order still read it — it is simply
                not a tab labelled embroidery_chest_left. */}
            {designableViews(garment).map((view) => {
              const count = layersOn(design, view.placement).length;
              const active = view.placement === placement;
              return (
                <button
                  key={view.placement}
                  type="button"
                  onClick={() => {
                    setPlacement(view.placement);
                    setSelected(null);
                  }}
                  className={[
                    "rounded-full px-4 py-1.5 text-[13px] transition",
                    active ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "bg-black/[.06] dark:bg-white/[.08]",
                  ].join(" ")}
                >
                  {view.label}
                  {count > 0 && <span className="ml-1.5 opacity-60">{count}</span>}
                </button>
              );
            })}
          </div>

          <CreationCanvas
            design={design}
            placement={placement}
            area={area}
            blankUrl={blank.url}
            colorHex={blank.tintWith}
            creatableId={creatableId}
            turning={turning}
            safeMargin={safeMargin}
            selectedLayerId={selected}
            onSelect={setSelected}
            onMove={(layerId, dx, dy) => setDesign((d) => applyOperation(d, { kind: "move", placement, layerId, dx, dy }))}
            onScale={(layerId, factor) => setDesign((d) => applyOperation(d, { kind: "scale", placement, layerId, factor }))}
          />

          {/* ============ WHOSE GARMENT IS ON THE CANVAS ==================
              Three different situations that all end with a drawing on screen,
              and they must not read the same:

                - the supplier's blanks could not be READ (a bug our end);
                - the supplier publishes none for this blank (their catalogue);
                - the real blank is there, and nothing needs saying.

              Silence for the third; the reason for the other two. The first is
              the one that was hidden, and hiding it is what let a broken data
              path look like a supplier with no pictures. */}
          {blankProblem ? (
            <p className="mt-3 text-center text-[12px] text-amber-600 dark:text-amber-400">
              Designing on a Genesis outline — your supplier&apos;s blank images
              couldn&apos;t be read. {blankProblem}
            </p>
          ) : blank.absence ? (
            // WHICH ABSENCE. "No image" was one sentence covering three
            // different situations, and only one of them is the supplier
            // having nothing. Reading "no blank image" when Printful had
            // published a dozen of them, just not in gold, is how a data
            // problem gets filed as a supplier limitation.
            <p className="mt-3 text-center text-[12px] text-zinc-500">
              {blank.absence === "none"
                ? "Designing on a Genesis outline — your supplier publishes no blank image for this product."
                : blank.absence === "other-colours"
                  ? `Designing on a Genesis outline — your supplier publishes blanks for this hoodie, but not in ${color}.`
                  : `Designing on a Genesis outline — your supplier publishes no blank for the ${placement}.`}{" "}
              The print area and colours are still theirs.
            </p>
          ) : null}

          {/* ============ SEVEN NAMED TOOLS ============================
              Every one of these is a door onto behaviour that already worked;
              what changed is that it has a name and a place. See
              DesignToolbar for why Paint is shown rather than hidden. */}
          <DesignToolbar
            tools={[
              {
                id: "color",
                label: "Color",
                icon: ToolIcons.color,
                ready: true,
                // ONLY WHAT THE MANUFACTURER MAKES. These are the supplier's
                // own colours with the supplier's own hex — there is no
                // free-colour picker here, because a colour Printful does not
                // stock is a product nobody can order.
                panel: colorPanel,
              },
              {
                id: "add",
                label: "Add",
                icon: ToolIcons.add,
                ready: true,
                panel: addPanel,
              },
              {
                id: "pad",
                label: "Pad",
                icon: ToolIcons.pad,
                ready: true,
                panel: padPanel,
              },
              {
                id: "edit",
                label: "Edit",
                icon: ToolIcons.edit,
                ready: true,
                disabled: !selected,
                disabledReason: "Tap a design on the garment first",
                panel: editPanel,
              },
              {
                id: "flip",
                label: "Flip",
                icon: ToolIcons.flip,
                ready: true,
                disabled: !selected,
                disabledReason: "Tap a design on the garment first",
                panel: flipPanel,
              },
              {
                id: "paint",
                label: "Paint",
                icon: ToolIcons.paint,
                ready: false,
                soon:
                  "Not built yet. This is where drawing, erasing and touching up artwork " +
                  "will live — on the artwork itself, not on the garment.",
              },
              {
                id: "spin",
                label: "Spin",
                icon: ToolIcons.spin,
                ready: true,
                onAct: spin,
                disabled: views.length < 2,
                disabledReason:
                  views.length < 2
                    ? "Your supplier published one view of this blank"
                    : undefined,
              },
            ]}
          />

          {!selected && !isEmpty(design) && (
            <p className="mt-3 text-center text-[12px] text-zinc-500">Tap a design to move or resize it.</p>
          )}
        </div>

        <aside className="flex flex-col gap-6">
          {/* COLOUR, SIZE AND ARTWORK NOW LIVE IN THE TOOLBAR (2026-08-27).
              They were here AND there for a moment, which is two places to
              change a colour and two places for them to disagree. The toolbar
              is where Sean asked for them; this column keeps what is not a
              tool — asking J4 for a change, and finishing. */}

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
