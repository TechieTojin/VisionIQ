/**
 * Detection colours.
 *
 * Colours are assigned by the label's RANK within a given analysis rather
 * than by hashing the label text. Hashing into a fixed palette collides —
 * `bottle` and `cup` landed on the same colour, and those two co-occur in
 * almost every shelf photo. Rank assignment guarantees that the categories
 * actually present in one image are always visually distinct, which is what
 * matters when reading an annotated image.
 */
const PALETTE = [
  '#5b8cff',
  '#2fbf71',
  '#ffb02e',
  '#ff5d6c',
  '#a78bfa',
  '#22d3ee',
  '#f472b6',
  '#84cc16',
  '#fb923c',
  '#38bdf8',
  '#c084fc',
  '#4ade80',
]

export const FALLBACK_COLOR = '#8e9bb8'

/**
 * Build a label -> colour map from labels in priority order (most frequent
 * first). Labels beyond the palette length wrap around, so very long tails
 * may repeat — by then the top categories are already distinguishable.
 */
export function buildColorMap(orderedLabels: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  let next = 0
  for (const label of orderedLabels) {
    if (map[label] === undefined) {
      map[label] = PALETTE[next % PALETTE.length]
      next++
    }
  }
  return map
}

/** Look up a colour, falling back to a neutral tone for unknown labels. */
export function colorFor(
  colors: Record<string, string>,
  label: string,
): string {
  return colors[label] ?? FALLBACK_COLOR
}
