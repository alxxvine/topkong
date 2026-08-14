// Small math, the things Mathf did in Unity.
//
// A separate module exists precisely so the ports of the other files read
// like their originals: where C# had Mathf.MoveTowards, here it is
// moveTowards — and the two versions can be compared line by line.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * clamp01(t);
export const lerpUnclamped = (a, b, t) => a + (b - a) * t;
export const inverseLerp = (a, b, v) => (a === b ? 0 : clamp01((v - a) / (b - a)));

export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Angle difference in degrees, wrapped to -180..180. */
export function deltaAngle(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Angle interpolation along the short arc — otherwise the club would
 *  spin through the whole body when crossing 180°. */
export function lerpAngle(a, b, t) {
  return a + deltaAngle(a, b) * clamp01(t);
}

/** Frame-rate-independent exponential smoothing.
 *  A direct stand-in for Lerp(a, b, Clamp01(k * dt)) at sane dt,
 *  but one that does not fall apart when a frame hitches. */
export function damp(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

// --- Noise ---
// Replaces Mathf.PerlinNoise. Value noise with smooth interpolation:
// for body sway and camera shake it is plenty, and honest gradient
// Perlin would add nothing here except code.

function hash2(ix, iy) {
  let h = ix * 374761393 + iy * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  // >>> 0 makes it unsigned: JS bitwise operators work on signed ints.
  return ((h >>> 0) % 100000) / 100000;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Smooth 0..1 noise. seed picks the "track", x is time. */
export function noise(seed, x) {
  const ix = Math.floor(x);
  const fx = smooth(x - ix);
  const iy = Math.floor(seed * 977) | 0;
  return lerpUnclamped(hash2(ix, iy), hash2(ix + 1, iy), fx);
}

/** Noise in -1..1 — the form almost every caller wants. */
export const noiseSigned = (seed, x) => noise(seed, x) * 2 - 1;
