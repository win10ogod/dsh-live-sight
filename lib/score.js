// How much a frame changed, measured on a coarse grid read straight from the packed
// BGRA/RGBA buffer: no decode, no resize, a few thousand reads per frame.

/** Grid that every frame is reduced to before comparing. 16:9, like most screens. */
export const GRID = Object.freeze({ cols: 64, rows: 36 })

const LATTICE = 3

/**
 * Average colour of each grid cell, as luma and two chroma differences (BT.601).
 * @param {{ buffer: Uint8Array, width: number, height: number, rowPitch?: number }} frame packed 4-byte pixels
 * @param {{ cols?: number, rows?: number, order?: 'bgra' | 'rgba' }} [options]
 * @returns {Float32Array} cols × rows × [Y, Cb, Cr]
 */
export function sampleGrid(frame, { cols = GRID.cols, rows = GRID.rows, order = 'bgra' } = {}) {
  const { buffer, width, height } = frame
  const pitch = frame.rowPitch || width * 4
  const [ri, gi, bi] = order === 'rgba' ? [0, 1, 2] : [2, 1, 0]
  const out = new Float32Array(cols * rows * 3)
  for (let row = 0; row < rows; row++) {
    const top = (row * height) / rows
    const span = height / rows
    for (let col = 0; col < cols; col++) {
      const left = (col * width) / cols
      const reach = width / cols
      let r = 0, g = 0, b = 0
      for (let sy = 0; sy < LATTICE; sy++) {
        const y = Math.min(height - 1, Math.floor(top + (span * (sy + 0.5)) / LATTICE))
        for (let sx = 0; sx < LATTICE; sx++) {
          const x = Math.min(width - 1, Math.floor(left + (reach * (sx + 0.5)) / LATTICE))
          const o = y * pitch + x * 4
          r += buffer[o + ri]
          g += buffer[o + gi]
          b += buffer[o + bi]
        }
      }
      const n = LATTICE * LATTICE
      r /= n; g /= n; b /= n
      const luma = 0.299 * r + 0.587 * g + 0.114 * b
      const i = (row * cols + col) * 3
      out[i] = luma
      out[i + 1] = 0.564 * (b - luma)
      out[i + 2] = 0.713 * (r - luma)
    }
  }
  return out
}

/**
 * Compare two grids of the same size.
 * `diff` is the mean per-cell change (0–1); `coverage` is the share of cells that changed noticeably,
 * which separates a scene change (most of the screen) from local motion (a cursor, a character).
 * @param {Float32Array} previous
 * @param {Float32Array} next
 * @param {{ cellThreshold?: number }} [options] per-cell change, on the 0–255 scale, that counts as changed
 */
export function compare(previous, next, { cellThreshold = 18 } = {}) {
  if (!previous || previous.length !== next.length) throw new Error('grids must be the same size')
  const cells = next.length / 3
  let sum = 0
  let changed = 0
  for (let i = 0; i < next.length; i += 3) {
    const d = Math.abs(next[i] - previous[i]) + 0.5 * (Math.abs(next[i + 1] - previous[i + 1]) + Math.abs(next[i + 2] - previous[i + 2]))
    sum += d
    if (d > cellThreshold) changed++
  }
  return { diff: sum / cells / 255, coverage: changed / cells }
}
