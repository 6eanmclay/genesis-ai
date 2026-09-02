"use client";

import { useEffect, useRef } from "react";

// THE NETWORK THE BUSINESS SITS INSIDE.
//
// ============ AN ORIGINAL LANGUAGE, NOT A REFERENCE (2026-09-01) =======
//
// Sean sent two reference images of green node-and-line networks and was
// explicit: "Do not copy either image, its exact composition, colors,
// typography, or distinctive visual elements... I do NOT want literal Matrix
// visuals. I do NOT want green falling code."
//
// So what is taken is the IDEA — connected points, subtle links, depth,
// clusters, a sense of information flowing — and nothing else. No green: the
// field is drawn in the map's own ink token, which is the same blue J4 is
// drawn in and which follows the theme. No dense lattice: this sits at a few
// percent opacity behind a white stage, where the references are the subject
// of their own image.
//
// It replaces the earlier falling-glyph treatment, which read as rain rather
// than as a network.
//
// ============ IT IS BACKDROP, AND STAYS BACKDROP ======================
//
// Sean: "Keep it readable, especially at 390px."
//
// Three things keep it underneath. Alpha is capped low. The hub is punched out
// with a radial fade so J4 and the branch labels always sit on clean ground.
// And links are only drawn between points that are genuinely close, so the
// field stays sparse instead of turning into a mesh.
//
// ============ AND IT IS OPTIONAL BY CONSTRUCTION ======================
//
// `prefers-reduced-motion` renders ONE static frame of the same field — not
// animated, and not blank. The map never depended on it moving.

interface Point {
  x: number;
  y: number;
  /** 0 = far, 1 = near. Drives size, alpha and drift speed together. */
  depth: number;
  vx: number;
  vy: number;
}

export function MapDataStream({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let points: Point[] = [];
    let width = 0;
    let height = 0;

    // ============ THE FIELD IS GENERATED ONCE ======================
    //
    // A resize used to re-roll the whole field, so under reduced motion the
    // canvas changed whenever the layout shifted — a still image that was not
    // still. The random pool is drawn once and only re-laid-out on resize.
    const seeds = Array.from({ length: 600 }, () => Math.random());
    let cursor = 0;
    const seed = () => seeds[cursor++ % seeds.length];

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Fewer points on a phone: the same density that reads as texture on a
      // desktop reads as noise in a 340px column.
      const count = width < 420 ? 34 : 68;
      cursor = 0;
      points = Array.from({ length: count }, () => {
        const depth = 0.25 + seed() * 0.75;
        const angle = seed() * Math.PI * 2;
        return {
          x: seed() * width,
          y: seed() * height,
          depth,
          // Slow, and slower the further away — parallax without a camera.
          vx: Math.cos(angle) * (2 + depth * 5),
          vy: Math.sin(angle) * (2 + depth * 5),
        };
      });
    };

    const inkOf = () =>
      getComputedStyle(canvas).getPropertyValue("--map-stream").trim() || "#1b5fc4";

    const draw = (dt: number) => {
      ctx.clearRect(0, 0, width, height);
      const ink = inkOf();
      const cx = width / 2;
      const cy = height / 2;
      // Nothing competes with J4 or the labels.
      const clear = Math.min(width, height) * 0.3;
      // Links only between genuine neighbours, so the field never becomes a mesh.
      const linkDistance = width < 420 ? 62 : 84;

      const fade = (x: number, y: number) => {
        const d = Math.hypot(x - cx, y - cy);
        return Math.min(1, Math.max(0, (d - clear) / (clear * 0.85)));
      };

      if (!reducedMotion) {
        for (const p of points) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.x < -20) p.x = width + 20;
          if (p.x > width + 20) p.x = -20;
          if (p.y < -20) p.y = height + 20;
          if (p.y > height + 20) p.y = -20;
        }
      }

      // ---- links first, so points sit on top of them ----------------------
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.6;
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const fa = fade(a.x, a.y);
        if (fa <= 0.02) continue;
        for (let j = i + 1; j < points.length; j++) {
          const b = points[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d > linkDistance) continue;
          const fb = fade(b.x, b.y);
          if (fb <= 0.02) continue;
          // Closer pairs are stronger, and the pair is only as visible as its
          // dimmer end.
          const strength = 1 - d / linkDistance;
          ctx.globalAlpha = strength * Math.min(fa, fb) * ((a.depth + b.depth) / 2) * 0.09;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // ---- the points themselves ------------------------------------------
      ctx.fillStyle = ink;
      for (const p of points) {
        const f = fade(p.x, p.y);
        if (f <= 0.02) continue;
        ctx.globalAlpha = f * p.depth * 0.3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 0.6 + p.depth * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
    };

    resize();

    if (reducedMotion) {
      // ONE FRAME. Same field, no loop, no timer left running.
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
