"use client";

// J4'S VOICE, AS A MARK.
//
// This replaces a literal 🔊 emoji, which read as a system alert from another
// decade and — being an emoji — rendered as a different picture on every
// platform. A control that speaks in J4's voice should look like J4, not like
// a volume warning.
//
// THE FORM IS THE ORB, SPEAKING. Genesis's avatar is a circle; this is that
// circle opened into a set of vertical bars — the same shape a moment later.
// Bars grow from the centre outward, so it reads as sound leaving a point
// rather than a meter filling up.
//
// It animates only while actually speaking. A waveform that moves when nothing
// is playing is decoration pretending to be state, and `prefers-reduced-motion`
// stops it entirely for anyone who has asked for that.

export function J4VoiceGlyph({
  speaking = false,
  size = 16,
}: {
  /** Animates only when audio is genuinely playing. */
  speaking?: boolean;
  size?: number;
}) {
  // Heights chosen so the silhouette is symmetrical about the centre bar and
  // reads as a shape rather than a random set of lines.
  const bars = [
    { x: 2, h: 6 },
    { x: 6, h: 12 },
    { x: 10, h: 16 },
    { x: 14, h: 12 },
    { x: 18, h: 6 },
  ];

  return (
    <>
      <svg
        width={size}
        height={size}
        viewBox="0 0 22 22"
        fill="none"
        aria-hidden="true"
        className={speaking ? "j4voice-on" : undefined}
      >
        {bars.map((bar, i) => (
          <rect
            key={bar.x}
            x={bar.x}
            // Centred vertically, so growth is symmetrical from the middle.
            y={(22 - bar.h) / 2}
            width="2.4"
            height={bar.h}
            rx="1.2"
            fill="currentColor"
            style={{
              transformOrigin: "center",
              // Staggered from the centre out, which is what makes it read as
              // sound travelling rather than five bars twitching together.
              animationDelay: `${Math.abs(i - 2) * 110}ms`,
            }}
          />
        ))}
      </svg>
      <style>{`
        .j4voice-on rect {
          animation: j4voice 900ms ease-in-out infinite;
        }
        @keyframes j4voice {
          0%, 100% { transform: scaleY(0.55); opacity: 0.75; }
          50%      { transform: scaleY(1);    opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .j4voice-on rect { animation: none; }
        }
      `}</style>
    </>
  );
}
