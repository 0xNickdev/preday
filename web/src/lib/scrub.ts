/** Scroll scenes are pure functions of progress. Every animated value goes through `range`. */

type Ease = (t: number) => number

export const outCubic: Ease = (t) => 1 - (1 - t) ** 3
export const inOutCubic: Ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)

/** Where `p` sits inside [a, b] as 0..1, clamped on both sides, then eased. */
export function range(p: number, [a, b]: [number, number], ease?: Ease) {
  const t = Math.min(1, Math.max(0, (p - a) / (b - a)))
  return ease ? ease(t) : t
}
