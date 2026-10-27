// -----------------------------------------------------------------------
// gain.ts
//
// Pure, unit-testable "proximity chat" gain calculator: given two XY
// positions on an infinite canvas (see Whiteboard.tsx, which broadcasts
// each user's cursor position via `awareness.setLocalStateField("position",
// {x, y})`), compute how loud `b` should sound to a listener at `a`.
//
// This module has ZERO runtime dependency on WebRTC/Web Audio/LiveKit by
// design - it's pure math so it's trivially testable (see gain.spec.ts).
// The real audio wiring is documented future work; here's exactly where it
// would plug in once LiveKit tracks are flowing (see Huddle.tsx):
//
//   room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
//     const audioTrack = track.attach() as HTMLAudioElement;
//     const ctx = new AudioContext();
//     const source = ctx.createMediaElementSource(audioTrack);
//     const gainNode = ctx.createGain();
//     source.connect(gainNode).connect(ctx.destination);
//
//     // Whenever either position updates (awareness change or local
//     // viewport pan):
//     gainNode.gain.value = computeGain(myPos, theirPos);
//   });
//
// -----------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

export type FalloffCurve = "linear" | "inverse-square";

export interface GainOptions {
  /** Distance (in the same units as x/y) within which gain is always 1. Default 150. */
  nearRadius?: number;
  /** Distance beyond which gain is always 0. Default 600. */
  farRadius?: number;
  /** Shape of the falloff between nearRadius and farRadius. Default "linear". */
  curve?: FalloffCurve;
}

const DEFAULT_OPTIONS: Required<GainOptions> = {
  nearRadius: 150,
  farRadius: 600,
  curve: "linear",
};

/**
 * Computes a [0, 1] audio gain multiplier for a listener at `listener` hearing a
 * source at `source`, based on Pythagorean distance between them.
 *
 *  - distance <= nearRadius  -> 1 (full volume)
 *  - distance >= farRadius   -> 0 (silent)
 *  - in between              -> falls off per `opts.curve`
 *
 * Always clamped to [0, 1]. Pure function - no side effects, no I/O -
 * that's what makes it trivially unit-testable and safe to call from a
 * render/animation loop.
 */
export function computeGain(listener: Vec2, source: Vec2, opts: GainOptions = {}): number {
  const { nearRadius, farRadius, curve } = { ...DEFAULT_OPTIONS, ...opts };

  if (farRadius <= nearRadius) {
    // Degenerate config: treat as a hard cutoff at nearRadius.
    const dist = distance(listener, source);
    return dist <= nearRadius ? 1 : 0;
  }

  const dist = distance(listener, source);

  if (dist <= nearRadius) return 1;
  if (dist >= farRadius) return 0;

  const span = farRadius - nearRadius;
  const normalizedDistance = (dist - nearRadius) / span; // 0 at nearRadius, 1 at farRadius

  let gain: number;
  if (curve === "inverse-square") {
    // Inverse-square-ish falloff normalized so it still hits exactly 0 at
    // farRadius and 1 at nearRadius (a "pure" 1/d^2 curve never reaches 0,
    // so we shape a falloff that *behaves* like inverse-square in feel -
    // fast drop near the listener, long tail - while still satisfying the
    // documented boundary conditions).
    gain = 1 - normalizedDistance * normalizedDistance;
  } else {
    // linear
    gain = 1 - normalizedDistance;
  }

  return clamp01(gain);
}

function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
