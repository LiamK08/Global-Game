// Proximity -> heat colour. A warm "OrRd" ramp: pale when far (proximity ~0),
// deep red when close (proximity ~1). Kept in sync with the --heat-* CSS vars.

const RAMP = [
  { p: 0.0, c: [255, 247, 236] }, // #fff7ec
  { p: 0.2, c: [254, 232, 200] }, // #fee8c8
  { p: 0.4, c: [253, 187, 132] }, // #fdbb84
  { p: 0.6, c: [252, 141, 89] }, // #fc8d59
  { p: 0.75, c: [239, 101, 72] }, // #ef6548
  { p: 0.88, c: [215, 48, 31] }, // #d7301f
  { p: 1.0, c: [127, 0, 0] }, // #7f0000
];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const toHex = (n) => n.toString(16).padStart(2, '0');

/**
 * Map a proximity in [0, 1] to a CSS hex colour on the heat ramp.
 * @param {number} proximity
 * @returns {string} e.g. "#ef6548"
 */
export function heatColor(proximity) {
  const p = clamp01(proximity);
  let lo = RAMP[0];
  let hi = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (p >= RAMP[i].p && p <= RAMP[i + 1].p) {
      lo = RAMP[i];
      hi = RAMP[i + 1];
      break;
    }
  }
  const span = hi.p - lo.p || 1;
  const t = (p - lo.p) / span;
  const ch = (i) => Math.round(lo.c[i] + (hi.c[i] - lo.c[i]) * t);
  return `#${toHex(ch(0))}${toHex(ch(1))}${toHex(ch(2))}`;
}

/** A CSS linear-gradient string sampling the full ramp (for legends). */
export function rampGradient(direction = 'to right') {
  const stops = RAMP.map((s) => `${heatColor(s.p)} ${Math.round(s.p * 100)}%`);
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}
