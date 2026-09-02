"use client";

import { useEffect, useRef } from "react";

// THE BUSINESS, SEEN FROM UNDERNEATH.
//
// ============ AN ORIGINAL GLYPH SET, DELIBERATELY (2026-09-01) =========
//
// Sean: "Do not copy the Matrix aesthetic or use recognizable Matrix
// typography/symbols. Create an original Genesis visual language using abstract
// data characters, points, particles, business/data glyphs, subtle streams."
//
// So: no katakana, no green-on-black, no mirrored characters. The alphabet
// below is the vocabulary of a business ledger read at a distance — digits,
// currency, percentages, deltas, the box-drawing marks of a table, and a few
// dots. It reads as *information* rather than as code, which is the actual
// subject: this is a merchant's own data flowing under their business.
//
// ============ AND IT STAYS UNDERNEATH =================================
//
// Sean: "Keep it restrained. The map and information remain readable. This
// should feel futuristic and intentional, not like a screen saver."
//
// Low alpha, slow drift, and it never draws over the centre — the hub is
// punched out with a radial fade so J4 and the branch labels always sit on
// clean ground. The map is painted in a separate SVG layer above this.
//
// ============ AND IT IS OPTIONAL BY CONSTRUCTION ======================
//
// `prefers-reduced-motion` renders ONE static frame — the same glyph field,
// not animated and not blank. A viewer who cannot take motion still gets the
// texture and loses nothing; the map itself never depended on it.

/** Digits, ledger marks, and deltas. Nothing alphabetic, nothing recognisable. */
const GLYPHS = "0123456789$%△▽·:+-|/\\◦◇□▪▫┼┤├╌═≈↗↘".split("");

interface Column {
  x: number;
  y: number;
  speed: number;
  glyphs: string[];
  alpha: number;
}

export function MapDataStream({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let columns: Column[] = [];
    let width = 0;
    let height = 0;

    // ============ THE FIELD IS GENERATED ONCE ======================
    //
    // A resize used to re-roll every glyph, so under reduced motion the canvas
    // changed whenever the layout shifted -- a still image that was not still.
    // The alphabet is drawn from this pool by index instead, so a resize
    // re-lays the columns out without inventing new characters.
    const pool = Array.from({ length: 512 }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]);
    const jitter = Array.from({ length: 512 }, () => Math.random());
    let cursor = 0;
    const nextGlyph = () => pool[cursor++ % pool.length];
    const nextJitter = () => jitter[cursor % jitter.length];

    // The device pixel ratio matters here: glyphs this faint turn to mush on a
    // phone if the backing store is not scaled.
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const spacing = width < 420 ? 26 : 34;
      const count = Math.max(6, Math.floor(width / spacing));
      cursor = 0;
      columns = Array.from({ length: count }, (_, i) => {
        const rows = Math.ceil(height / 18) + 4;
        const j = nextJitter();
        return {
          x: i * spacing + spacing / 2,
          y: j * height,
          speed: 6 + j * 12,
          alpha: 0.25 + j * 0.45,
          glyphs: Array.from({ length: rows }, () => nextGlyph()),
        };
      });
    };

    // Read the map's own tokens so the stream belongs to the theme rather than
    // carrying a colour of its own.
    const inkOf = () => {
      const styles = getComputedStyle(canvas);
      return styles.getPropertyValue("--map-stream").trim() || "rgba(27, 95, 196, 1)";
    };

    const draw = (dt: number) => {
      ctx.clearRect(0, 0, width, height);
      const ink = inkOf();
      ctx.font = `${width < 420 ? 11 : 13}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = "center";

      const cx = width / 2;
      const cy = height / 2;
      // The hub is punched out so nothing ever competes with J4 or the labels.
      const clear = Math.min(width, height) * 0.34;

      for (const col of columns) {
        if (!reducedMotion) col.y += col.speed * dt;
        if (col.y > height + 40) col.y = -40;

        for (let r = 0; r < col.glyphs.length; r++) {
          const y = ((col.y + r * 18) % (height + 80)) - 40;
          if (y < -20 || y > height + 20) continue;

          // Distance fade around the centre, plus a gentle head-to-tail fade
          // so a column reads as a stream rather than a dotted line.
          const d = Math.hypot(col.x - cx, y - cy);
          const near = Math.min(1, Math.max(0, (d - clear) / (clear * 0.9)));
          const tail = 1 - r / col.glyphs.length;
          const a = col.alpha * near * (0.25 + tail * 0.75) * 0.16;
          if (a <= 0.004) continue;

          ctx.globalAlpha = a;
          ctx.fillStyle = ink;
          ctx.fillText(col.glyphs[r], col.x, y);
        }
      }
      ctx.globalAlpha = 1;
    };

    resize();

    if (reducedMotion) {
      // ONE FRAME. Same texture, no loop, no timer left running.
      draw(0);
      const onResize = () => {
        resize();
        draw(0);
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      draw(dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onResize = () => resize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [reducedMotion]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      data-testid="map-data-stream"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
