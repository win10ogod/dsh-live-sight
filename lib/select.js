// Which sampled frames are worth showing the model, and when a set of them is ready.
// A scene change (most of the screen changed) keeps a frame at once; steady motion keeps one
// each time enough change has accumulated; a still screen keeps nothing.

import { compare } from './score.js'

export const SELECT_DEFAULTS = Object.freeze({
  /** Share of grid cells that must change for a scene change. */
  cutCoverage: 0.3,
  /** Mean change (0–1) that a scene change must also reach. */
  cutDiff: 0.06,
  /** Accumulated mean change that earns another frame while the screen keeps moving. */
  motionQuota: 0.35,
  /** Kept frames are at least this far apart. */
  minSpacingMs: 700,
  /** Frames per sheet; when more arrive before delivery, the sheet shows this many spread evenly over the time. */
  maxFrames: 6,
  /** A sheet is ready once its oldest frame is this old. */
  maxAgeMs: 20_000,
  /** After a scene change, a sheet is ready once this long has passed without another one. */
  settleMs: 1_200,
  /** Per-cell change on the 0–255 scale that counts toward coverage. */
  cellThreshold: 18,
})

/** Frames held while the agent is busy, in sheets. */
const POOL_SHEETS = 4

/**
 * Pick `count` frames spread evenly over the time the frames cover: the oldest, the newest, and the ones
 * nearest to evenly spaced moments in between (a scene change wins over motion when nearly as close).
 * Choosing by change score instead kept losing the same kind of change — two similar colours always score
 * low — and the model concluded that those scenes had disappeared (live test, 2026-11-13).
 */
export function spread(frames, count) {
  if (count <= 0) return []
  if (frames.length <= count) return frames
  if (count === 1) return [frames.at(-1)]
  const first = frames[0].at
  const slot = (frames.at(-1).at - first) / (count - 1) || 1
  const chosen = new Set([0, frames.length - 1])
  for (let k = 1; k < count - 1; k++) {
    const target = first + k * slot
    let best = -1
    let bestCost = Infinity
    for (let i = 1; i < frames.length - 1; i++) {
      if (chosen.has(i)) continue
      const cost = Math.abs(frames[i].at - target) / slot - (frames[i].reason === 'motion' ? 0 : 0.25)
      if (cost < bestCost) { best = i; bestCost = cost }
    }
    if (best >= 0) chosen.add(best)
  }
  return [...chosen].sort((a, b) => a - b).map(i => frames[i])
}

export class FrameSelector {
  constructor(options = {}) {
    this.options = { ...SELECT_DEFAULTS, ...options }
    if (this.options.maxFrames < 1) throw new Error('maxFrames must be at least 1')
    this.reset()
  }

  reset() {
    this.previous = null
    this.kept = []
    this.motion = 0
    this.lastKeptAt = -Infinity
    this.lastCutAt = null
    this.pendingCut = false
    this.dropped = 0
  }

  /**
   * Feed one sampled frame.
   * @param {Float32Array} grid from sampleGrid
   * @param {number} now milliseconds
   * @param {() => unknown} makeTile called only when the frame is kept, so large buffers are not held
   * @returns {{ reason: 'first' | 'cut' | 'motion' | null, diff: number, coverage: number }}
   */
  push(grid, now, makeTile) {
    const o = this.options
    if (!this.previous) {
      this.previous = grid
      this.keep(makeTile(), now, 'first', 1)
      return { reason: 'first', diff: 0, coverage: 0 }
    }
    const { diff, coverage } = compare(this.previous, grid, { cellThreshold: o.cellThreshold })
    this.previous = grid
    const cut = coverage >= o.cutCoverage && diff >= o.cutDiff
    if (cut) {
      this.lastCutAt = now
      this.pendingCut = true
    } else this.motion += diff
    if (now - this.lastKeptAt < o.minSpacingMs) return { reason: null, diff, coverage }
    if (this.pendingCut) {
      this.keep(makeTile(), now, 'cut', 1 + diff)
      return { reason: 'cut', diff, coverage }
    }
    if (this.motion >= o.motionQuota) {
      this.keep(makeTile(), now, 'motion', this.motion)
      return { reason: 'motion', diff, coverage }
    }
    return { reason: null, diff, coverage }
  }

  keep(tile, at, reason, score) {
    this.kept.push({ tile, at, reason, score })
    this.lastKeptAt = at
    this.motion = 0
    this.pendingCut = false
    // While the agent is busy the frames pile up; hold a few sheets' worth, then thin the most crowded stretch.
    if (this.kept.length > this.options.maxFrames * POOL_SHEETS) {
      this.kept.splice(this.dropIndex(), 1)
      this.dropped++
    }
  }

  /**
   * Which held frame to give up: never the oldest or the newest, motion before scene changes, and among
   * those the one whose neighbours are closest in time, so what remains still covers the whole stretch.
   */
  dropIndex() {
    const k = this.kept
    if (k.length <= 2) return 0
    let best = -1
    for (let i = 1; i < k.length - 1; i++) {
      if (best < 0) { best = i; continue }
      const motion = k[i].reason === 'motion', bestMotion = k[best].reason === 'motion'
      if (motion !== bestMotion) { if (motion) best = i; continue }
      const span = k[i + 1].at - k[i - 1].at, bestSpan = k[best + 1].at - k[best - 1].at
      if (span < bestSpan || (span === bestSpan && k[i].score < k[best].score)) best = i
    }
    return best
  }

  /** Whether the kept frames should be shown now. */
  ready(now) {
    const o = this.options
    if (this.kept.length === 0) return false
    if (this.kept.length >= o.maxFrames) return true
    if (now - this.kept[0].at >= o.maxAgeMs) return true
    return this.lastCutAt !== null && now - this.lastCutAt >= o.settleMs
  }

  /** Time of the newest kept frame, or null. */
  get lastKeptFrameAt() {
    return this.kept.length ? this.kept.at(-1).at : null
  }

  /** Change accumulated since the last kept frame (0 right after keeping one). */
  get pendingMotion() {
    return this.motion
  }

  /**
   * Hand over the kept frames and start the next sheet. The previous grid stays as the baseline.
   * @param {number} [count] frames wanted, maxFrames by default
   * @returns {{ frames: { tile: unknown, at: number, reason: string, score: number }[], dropped: number }} dropped: frames left out for lack of room
   */
  take(count = this.options.maxFrames) {
    const frames = spread(this.kept, Math.max(0, count))
    const taken = { frames, dropped: this.dropped + this.kept.length - frames.length }
    this.kept = []
    this.dropped = 0
    this.lastCutAt = null
    return taken
  }
}
