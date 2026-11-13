// Frames → one image the model reads at once: area-averaged tiles in a grid, each labelled with
// its order and time. Sizes snap to the model's image patch so no partial patch is paid for.

export const SHEET_DEFAULTS = Object.freeze({
  /** Width of one tile in a sheet. */
  tileWidth: 448,
  /** Image patch size of the vision model; tile and look sizes are multiples of it. */
  align: 28,
})

/**
 * Image size for a source: `width` capped at the source width, both sides multiples of `align`
 * (never larger than the source, so nothing is upscaled and no partial patch is paid for).
 */
export function fitSize(sourceWidth, sourceHeight, width, align) {
  const w = Math.max(align, Math.floor(Math.min(width, sourceWidth) / align) * align)
  const h = Math.min(tileHeightFor(sourceWidth, sourceHeight, w, align), Math.max(align, Math.floor(sourceHeight / align) * align))
  return { width: Math.min(w, sourceWidth), height: Math.min(h, sourceHeight) }
}

/** Tile height for a source aspect ratio, a multiple of `align`. */
export function tileHeightFor(sourceWidth, sourceHeight, tileWidth, align) {
  return Math.max(align, Math.round((tileWidth * sourceHeight) / sourceWidth / align) * align)
}

/**
 * Area-average a region of a packed BGRA/RGBA frame into an RGBA tile. Never upscales: the result is at
 * most the region's own size, keeping its aspect ratio when `height` is omitted.
 * @param {{ buffer: Uint8Array, width: number, height: number, rowPitch?: number }} frame
 * @param {{ width: number, height?: number, order?: 'bgra' | 'rgba', region?: { x: number, y: number, width: number, height: number }, align?: number }} options
 * @returns {{ pixels: Uint8Array, width: number, height: number }}
 */
export function downscale(frame, { width, height, order = 'bgra', region, align = 1 }) {
  const area = region || { x: 0, y: 0, width: frame.width, height: frame.height }
  const pitch = frame.rowPitch || frame.width * 4
  const outW = Math.max(1, Math.min(width, area.width))
  const outH = Math.max(1, Math.min(height ?? Math.max(align, Math.round((outW * area.height) / area.width / align) * align), area.height))
  const [ri, gi, bi] = order === 'rgba' ? [0, 1, 2] : [2, 1, 0]
  const src = frame.buffer
  const out = new Uint8Array(outW * outH * 4)
  const sx = area.width / outW
  const sy = area.height / outH
  for (let y = 0; y < outH; y++) {
    const y0 = area.y + Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, area.y + Math.floor((y + 1) * sy))
    for (let x = 0; x < outW; x++) {
      const x0 = area.x + Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, area.x + Math.floor((x + 1) * sx))
      let r = 0, g = 0, b = 0
      for (let yy = y0; yy < y1; yy++) {
        let o = yy * pitch + x0 * 4
        for (let xx = x0; xx < x1; xx++, o += 4) {
          r += src[o + ri]
          g += src[o + gi]
          b += src[o + bi]
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const p = (y * outW + x) * 4
      out[p] = r / n
      out[p + 1] = g / n
      out[p + 2] = b / n
      out[p + 3] = 255
    }
  }
  return { pixels: out, width: outW, height: outH }
}

/** Columns for a sheet of `count` tiles: one row up to two, then two or three wide. */
export function columnsFor(count) {
  // Up to three tiles side by side, four as 2×2, more in rows of three: as few empty cells as possible.
  return count <= 3 ? count : count === 4 ? 2 : 3
}

/**
 * Lay tiles out left to right, top to bottom, and label each one.
 * @param {{ pixels: Uint8Array, width: number, height: number }[]} tiles all the same size
 * @param {string[]} labels one per tile
 * @returns {{ pixels: Uint8Array, width: number, height: number, columns: number, rows: number, empty: number }}
 */
export function composeSheet(tiles, labels = []) {
  if (tiles.length === 0) throw new Error('a sheet needs at least one tile')
  // Tiles differ in size when the watched window or the display was resized between them: every cell takes
  // the largest size and smaller tiles sit centred on grey.
  const tw = Math.max(...tiles.map(t => t.width))
  const th = Math.max(...tiles.map(t => t.height))
  const columns = columnsFor(tiles.length)
  const rows = Math.ceil(tiles.length / columns)
  const width = columns * tw
  const height = rows * th
  const out = new Uint8Array(width * height * 4)
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  tiles.forEach((tile, index) => {
    const ox = (index % columns) * tw
    const oy = Math.floor(index / columns) * th
    if (tile.width !== tw || tile.height !== th) fill(out, width, ox, oy, tw, th, 48)
    const px = ox + ((tw - tile.width) >> 1)
    const py = oy + ((th - tile.height) >> 1)
    for (let y = 0; y < tile.height; y++) out.set(tile.pixels.subarray(y * tile.width * 4, (y + 1) * tile.width * 4), ((py + y) * width + px) * 4)
    if (columns > 1 || rows > 1) frameTile(out, width, ox, oy, tw, th)
    if (labels[index]) drawLabel(out, width, ox + 4, oy + 4, labels[index])
  })
  // Cells after the last tile are hatched grey, so they cannot be read as a black frame.
  for (let index = tiles.length; index < columns * rows; index++) hatch(out, width, (index % columns) * tw, Math.floor(index / columns) * th, tw, th)
  return { pixels: out, width, height, columns, rows, empty: columns * rows - tiles.length }
}

function fill(pixels, width, ox, oy, tw, th, value) {
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const p = ((oy + y) * width + ox + x) * 4
      pixels[p] = value; pixels[p + 1] = value; pixels[p + 2] = value
    }
  }
}

function hatch(pixels, width, ox, oy, tw, th) {
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const p = ((oy + y) * width + ox + x) * 4
      const v = (x + y) % 16 < 3 ? 120 : 64
      pixels[p] = v; pixels[p + 1] = v; pixels[p + 2] = v
    }
  }
}

/** A thin dark edge so neighbouring tiles read as separate moments. */
function frameTile(pixels, width, ox, oy, tw, th) {
  const shade = (x, y) => {
    const p = (y * width + x) * 4
    pixels[p] = pixels[p] * 0.25
    pixels[p + 1] = pixels[p + 1] * 0.25
    pixels[p + 2] = pixels[p + 2] * 0.25
  }
  for (let x = ox; x < ox + tw; x++) { shade(x, oy); shade(x, oy + th - 1) }
  for (let y = oy; y < oy + th; y++) { shade(ox, y); shade(ox + tw - 1, y) }
}

// 5×7 glyphs for tile labels: order, minutes:seconds and the word NOW.
const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
}

const SCALE = 2
const PAD = 3

/** White label on a dark plate, at (x, y) of an RGBA buffer `width` pixels wide. */
export function drawLabel(pixels, width, x, y, text) {
  const chars = [...text].filter(ch => GLYPHS[ch])
  const plateW = chars.length * 6 * SCALE - SCALE + PAD * 2
  const plateH = 7 * SCALE + PAD * 2
  const height = pixels.length / 4 / width
  for (let py = y; py < Math.min(height, y + plateH); py++) {
    for (let px = x; px < Math.min(width, x + plateW); px++) {
      const p = (py * width + px) * 4
      pixels[p] = pixels[p] * 0.3
      pixels[p + 1] = pixels[p + 1] * 0.3
      pixels[p + 2] = pixels[p + 2] * 0.3
    }
  }
  chars.forEach((ch, index) => {
    const glyph = GLYPHS[ch]
    const gx = x + PAD + index * 6 * SCALE
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== '1') continue
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const px = gx + col * SCALE + dx
            const py = y + PAD + row * SCALE + dy
            if (px >= width || py >= height) continue
            const p = (py * width + px) * 4
            pixels[p] = 255
            pixels[p + 1] = 255
            pixels[p + 2] = 255
          }
        }
      }
    }
  })
}

/** Elapsed time as m:ss.s under ten minutes, m:ss after. */
export function elapsedLabel(ms) {
  // Round before splitting into minutes, so 59.96 s reads 1:00.0, never 0:60.0.
  const tenths = Math.round(Math.max(0, ms) / 100)
  const minutes = Math.floor(tenths / 600)
  if (minutes >= 10) return `${minutes}:${String(Math.floor((tenths % 600) / 10)).padStart(2, '0')}`
  return `${minutes}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`
}
