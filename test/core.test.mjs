import test from 'node:test'
import assert from 'node:assert/strict'
import { sampleGrid, compare } from '../lib/score.js'
import { FrameSelector } from '../lib/select.js'
import { downscale, composeSheet, tileHeightFor, columnsFor, elapsedLabel } from '../lib/sheet.js'

// Synthetic packed BGRA frames: a background colour and an optional bright square.
function frame(width, height, bg, square) {
  const buffer = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = square && x >= square.x && x < square.x + square.size && y >= square.y && y < square.y + square.size
      const [b, g, r] = inside ? [255, 255, 255] : bg
      const o = (y * width + x) * 4
      buffer[o] = b; buffer[o + 1] = g; buffer[o + 2] = r; buffer[o + 3] = 255
    }
  }
  return { buffer, width, height }
}

test('a still screen scores zero, a scene change covers most of the grid, a moving square only a little', () => {
  const blue = frame(320, 180, [200, 40, 20])
  const red = frame(320, 180, [20, 40, 200])
  const moved = frame(320, 180, [200, 40, 20], { x: 40, y: 40, size: 30 })
  const a = sampleGrid(blue)
  assert.deepEqual(compare(a, sampleGrid(blue)), { diff: 0, coverage: 0 })
  const cut = compare(a, sampleGrid(red))
  assert.ok(cut.coverage > 0.95 && cut.diff > 0.2, JSON.stringify(cut))
  const motion = compare(a, sampleGrid(moved))
  assert.ok(motion.coverage > 0 && motion.coverage < 0.1, JSON.stringify(motion))
})

test('row pitch wider than the image is honoured', () => {
  const base = frame(64, 36, [10, 20, 30])
  const pitch = 64 * 4 + 32
  const padded = new Uint8Array(pitch * 36).fill(255)
  for (let y = 0; y < 36; y++) padded.set(base.buffer.subarray(y * 256, (y + 1) * 256), y * pitch)
  assert.deepEqual(compare(sampleGrid(base), sampleGrid({ buffer: padded, width: 64, height: 36, rowPitch: pitch })), { diff: 0, coverage: 0 })
})

test('selector: first frame kept, still frames ignored, a scene change kept and the sheet ready after it settles', () => {
  const s = new FrameSelector({ minSpacingMs: 500, settleMs: 1000 })
  const still = sampleGrid(frame(160, 90, [200, 40, 20]))
  const other = sampleGrid(frame(160, 90, [20, 200, 40]))
  let tiles = 0
  const make = () => ++tiles
  assert.equal(s.push(still, 0, make).reason, 'first')
  for (let t = 500; t <= 3000; t += 500) assert.equal(s.push(still, t, make).reason, null)
  assert.equal(s.ready(3000), false, 'one first frame alone waits for maxAge')
  assert.equal(s.push(other, 3500, make).reason, 'cut')
  assert.equal(s.ready(4000), false, 'not settled yet')
  assert.equal(s.ready(4500), true)
  const { frames, dropped } = s.take()
  assert.deepEqual(frames.map(f => f.reason), ['first', 'cut'])
  assert.equal(dropped, 0)
  assert.equal(tiles, 2, 'tiles are made only for kept frames')
  assert.equal(s.ready(10_000), false)
})

test('selector: steady motion earns frames by accumulated change, never closer than minSpacing', () => {
  const s = new FrameSelector({ minSpacingMs: 700, motionQuota: 0.01 })
  s.push(sampleGrid(frame(160, 90, [0, 0, 0])), 0, () => 0)
  const reasons = []
  for (let i = 1; i <= 20; i++) {
    const g = sampleGrid(frame(160, 90, [0, 0, 0], { x: i * 6, y: 30, size: 20 }))
    reasons.push({ t: i * 250, r: s.push(g, i * 250, () => i).reason })
  }
  const kept = reasons.filter(x => x.r === 'motion')
  assert.ok(kept.length >= 3, JSON.stringify(reasons))
  for (let i = 1; i < kept.length; i++) assert.ok(kept[i].t - kept[i - 1].t >= 700)
})

test('selector: past maxFrames the sheet keeps the oldest and the newest and counts what it left out', () => {
  const s = new FrameSelector({ maxFrames: 3, minSpacingMs: 0, motionQuota: 0 })
  const colours = [[0, 0, 0], [0, 0, 30], [0, 0, 60], [250, 250, 250], [0, 0, 90]]
  colours.forEach((c, i) => s.push(sampleGrid(frame(160, 90, c)), i * 100, () => i))
  const { frames, dropped } = s.take()
  assert.deepEqual(frames.map(f => f.reason), ['first', 'cut', 'cut'])
  assert.equal(frames.at(-1).tile, 4, 'the newest frame is kept')
  assert.equal(dropped, 2)
})

test('selector: a long backlog of scene changes keeps every kind of scene, spread over the whole stretch', () => {
  // Four scenes in a loop, like the live test: two of the changes are between similar blues and score low.
  // Dropping by score alone lost those two scenes every time and the model said they had disappeared.
  const scenes = [[138, 58, 30], [29, 29, 127], [45, 83, 20], [129, 46, 49]]
  const s = new FrameSelector({ maxFrames: 6, minSpacingMs: 0 })
  for (let i = 0; i < 16; i++) s.push(sampleGrid(frame(160, 90, scenes[i % 4])), i * 9000, () => i)
  const { frames, dropped } = s.take()
  assert.equal(frames.length, 6)
  assert.ok(dropped >= 6, `dropped ${dropped}`)
  assert.deepEqual(new Set(frames.map(f => f.tile % 4)), new Set([0, 1, 2, 3]), JSON.stringify(frames.map(f => f.tile)))
  assert.equal(frames[0].tile, 0, 'the oldest frame stays')
  assert.equal(frames.at(-1).tile, 15, 'the newest frame stays')
  const gaps = frames.slice(1).map((f, i) => f.at - frames[i].at)
  assert.ok(Math.max(...gaps) <= 4 * 9000, JSON.stringify(gaps))
})

test('selector: a very long backlog is thinned while held, still from oldest to newest', () => {
  const s = new FrameSelector({ maxFrames: 3, minSpacingMs: 0 })
  const scenes = [[138, 58, 30], [29, 29, 127], [45, 83, 20], [250, 250, 250]]
  for (let i = 0; i < 40; i++) s.push(sampleGrid(frame(160, 90, scenes[i % 4])), i * 1000, () => i)
  assert.ok(s.kept.length <= 12, `held ${s.kept.length}`)
  const { frames, dropped } = s.take()
  assert.equal(frames[0].tile, 0)
  assert.equal(frames.at(-1).tile, 39)
  assert.equal(frames.length + dropped, 40 - 0, 'every kept frame is either shown or counted as left out')
})

test('selector: a sheet is ready when full or when its oldest frame is old enough', () => {
  const s = new FrameSelector({ maxFrames: 2, maxAgeMs: 5000, minSpacingMs: 0, motionQuota: 0.0001 })
  s.push(sampleGrid(frame(160, 90, [0, 0, 0])), 0, () => 0)
  assert.equal(s.ready(4999), false)
  assert.equal(s.ready(5000), true)
  s.push(sampleGrid(frame(160, 90, [0, 0, 0], { x: 0, y: 0, size: 10 })), 100, () => 1)
  assert.equal(s.ready(200), true)
})

test('downscale averages areas, keeps aspect, never upscales, and reads a region', () => {
  const f = frame(400, 200, [0, 0, 0], { x: 0, y: 0, size: 200 })
  const half = downscale(f, { width: 4, height: 2 })
  assert.deepEqual([half.width, half.height], [4, 2])
  assert.deepEqual([...half.pixels.subarray(0, 4)], [255, 255, 255, 255], 'white quarter from BGRA as RGBA')
  assert.deepEqual([...half.pixels.subarray(8, 12)], [0, 0, 0, 255])
  const native = downscale(f, { width: 4000 })
  assert.deepEqual([native.width, native.height], [400, 200], 'no upscaling')
  const region = downscale(f, { width: 50, region: { x: 150, y: 0, width: 100, height: 100 } })
  assert.deepEqual([region.width, region.height], [50, 50])
  assert.equal(region.pixels[0], 255)
  assert.equal(region.pixels[(49) * 4], 0)
})

test('tile sizes snap to the patch size, sheets lay out in at most three columns', () => {
  assert.equal(tileHeightFor(2560, 1440, 448, 28), 252)
  assert.equal(tileHeightFor(1920, 1200, 448, 28), 280)
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(columnsFor), [1, 2, 3, 2, 3, 3, 3, 3, 3])
  const t = { pixels: new Uint8Array(28 * 28 * 4).fill(100), width: 28, height: 28 }
  const sheet = composeSheet([t, t, t, t, t], ['1 0:00.0', '2', '3', '4', 'NOW'])
  assert.deepEqual([sheet.width, sheet.height, sheet.columns, sheet.rows, sheet.empty], [84, 56, 3, 2, 1])
  assert.ok(sheet.width % 28 === 0 && sheet.height % 28 === 0)
  // The empty sixth cell is hatched grey, never black: a model read a black cell as the screen going dark.
  const cell = (x, y) => sheet.pixels[((28 + y) * 84 + 56 + x) * 4]
  assert.ok(cell(14, 14) >= 64 && new Set(Array.from({ length: 16 }, (_, i) => cell(i, 0))).size === 2)
  assert.equal(composeSheet([t, t, t]).empty, 0, 'three tiles sit in one row')
})

test('elapsed labels read as m:ss.s', () => {
  assert.equal(elapsedLabel(0), '0:00.0')
  assert.equal(elapsedLabel(3450), '0:03.5')
  assert.equal(elapsedLabel(65_000), '1:05.0')
  assert.equal(elapsedLabel(12 * 60_000 + 7000), '12:07')
  assert.equal(elapsedLabel(59_960), '1:00.0', 'rounding never shows 0:60.0')
  assert.equal(elapsedLabel(119_970), '2:00.0')
  assert.equal(elapsedLabel(599_960), '10:00')
})

test('tiles of different sizes (a resize while watching) share one sheet, centred in equal cells', () => {
  const tile = (w, h, v) => ({ pixels: new Uint8Array(w * h * 4).fill(v), width: w, height: h })
  const sheet = composeSheet([tile(56, 28, 200), tile(56, 56, 100)])
  assert.deepEqual([sheet.width, sheet.height], [112, 56])
  const at = (x, y) => sheet.pixels[(y * 112 + x) * 4]
  assert.equal(at(28, 28), 200, 'the short tile sits in the middle of its cell')
  assert.equal(at(28, 5), 48, 'grey above it')
})

test('a one-frame sheet is one frame', async () => {
  const { spread } = await import('../lib/select.js')
  const f = [{ at: 0 }, { at: 1 }, { at: 2 }]
  assert.deepEqual(spread(f, 0), [])
  assert.deepEqual(spread(f, 1), [f[2]])
})

test('fitSize caps at the source, snaps both sides to the patch size and never upscales', async () => {
  const { fitSize } = await import('../lib/sheet.js')
  assert.deepEqual(fitSize(2560, 1440, 448, 28), { width: 448, height: 252 })
  assert.deepEqual(fitSize(320, 180, 448, 28), { width: 308, height: 168 })
  assert.deepEqual(fitSize(20, 10, 448, 28), { width: 20, height: 10 }, 'smaller than one patch stays as it is')
})
