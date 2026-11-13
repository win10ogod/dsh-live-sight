// Native capture through @screen-capture/node: Windows Graphics Capture, ScreenCaptureKit, or the
// Wayland ScreenCast portal. Frames are packed BGRA; only the newest one is held.

/** Load the native module; injectable so tests and unsupported hosts get a clear path. */
export async function loadNative() {
  return import('@screen-capture/node')
}

/**
 * A target as the user or the model names it.
 * A resolved window also carries its handle, so pausing and resuming keep watching the same window.
 * @typedef {{ kind: 'screen', monitor: number } | { kind: 'window', title: string, handle?: number } | { kind: 'foreground' }} Target
 */

/** Read `screen`, `screen 2`, `window <title>`, `foreground`; anything else is a window title. */
export function parseTarget(text) {
  const value = String(text || '').trim()
  if (!value || value === 'screen') return { kind: 'screen', monitor: 1 }
  const screen = /^screen\s+(\d+)$/i.exec(value)
  if (screen) return { kind: 'screen', monitor: Number(screen[1]) }
  if (/^(foreground|focus|front)$/i.test(value)) return { kind: 'foreground' }
  const window = /^window\s+(.+)$/i.exec(value)
  return { kind: 'window', title: (window ? window[1] : value).trim() }
}

/** Human-readable target, used in status lines and in what the model is told it is seeing. */
export function describeTarget(target) {
  if (target.kind === 'foreground') return '最前面的視窗'
  if (target.kind === 'screen') return target.monitor === 1 ? '主螢幕' : `第 ${target.monitor} 個螢幕`
  return `視窗「${target.title}」`
}

/**
 * Resolve a target to capture options and geometry. `foreground` becomes the window in front at this moment
 * (the caller waits first, so the user can bring the game forward); a resolved window is then followed by
 * its handle, whatever has focus later.
 */
export function resolveTarget(native, target) {
  if (target.kind === 'foreground') {
    const w = native.foregroundWindow()
    if (!w?.isValid) throw new Error('no window is in front')
    return windowTarget(w)
  }
  if (target.kind === 'window') {
    const w = target.handle ? windowByHandle(native, target.handle) : native.windowFromContainsName(target.title)
    if (!w?.isValid) throw new Error(target.handle ? `the window "${target.title}" is gone` : `no window title contains "${target.title}"`)
    return windowTarget(w)
  }
  const m = native.monitorFromIndex(target.monitor)
  return { options: { monitorIndex: target.monitor }, geometry: { monitor: target.monitor, width: m.width, height: m.height }, target }
}

function windowTarget(w) {
  return { options: { windowHandle: w.handle }, geometry: windowGeometry(w), target: { kind: 'window', title: w.title, handle: w.handle } }
}

/** Where a resolved target is now: a window may have moved since watching began. */
export function currentGeometry(native, target) {
  if (target?.kind !== 'window' || !target.handle) return null
  const w = windowByHandle(native, target.handle)
  return w?.isValid ? windowGeometry(w) : null
}

/** Windows throws for the handle of a closed window instead of returning an invalid one. */
function windowByHandle(native, handle) {
  try {
    return native.windowFromHandle(handle)
  } catch {
    return null
  }
}

/**
 * Screen position of the captured frame's top-left pixel. On Windows 10 and 11 a window's rectangle includes
 * invisible resize borders that the capture leaves out (a 960×540 window gave a 946×533 frame): equal borders
 * left and right, the same at the bottom, and at the top only what remains. Measured for a normal window at
 * 100% display scaling; a maximized window (borders on all four sides) and other scalings are not measured.
 */
export function frameOrigin(geometry, frame) {
  if (geometry?.left === undefined) return null
  const side = Math.max(0, Math.round((geometry.width - frame.width) / 2))
  const top = Math.max(0, geometry.height - frame.height - side)
  return { left: geometry.left + side, top: geometry.top + top }
}

function windowGeometry(w) {
  return { window: w.title, process: w.processName, left: w.rect.left, top: w.rect.top, width: w.rect.right - w.rect.left, height: w.rect.bottom - w.rect.top }
}

/** Visible top-level windows, for choosing what to watch. */
export function listWindows(native) {
  return native.enumerateWindows()
    .filter(w => w.isValid && w.title && w.width > 0 && w.height > 0)
    .map(w => ({ title: w.title, process: w.processName, width: w.width, height: w.height }))
}

export class ScreenSource {
  /**
   * @param {{ target: Target, fps: number, native?: object, now?: () => number }} options
   */
  constructor({ target, fps, native, now = Date.now }) {
    this.requested = target
    this.fps = fps
    this.native = native
    this.now = now
    this.capture = null
    this.latest = null
    this.seq = 0
    this.ended = null
    this.reading = null
  }

  async start() {
    const native = this.native || (this.native = await loadNative())
    if (!native.isSupported()) throw new Error('screen capture is not available on this system')
    const resolved = resolveTarget(native, this.requested)
    this.target = resolved.target
    this.geometry = resolved.geometry
    const support = native.captureApiSupport?.() || {}
    const options = { ...resolved.options, colorFormat: 'bgra8', cursorCapture: true }
    // The overlay shows that capture is on; the yellow system border would sit on top of the game.
    if (support.borderSettings) options.drawBorder = false
    if (support.minimumUpdateInterval) options.minimumUpdateIntervalMs = Math.max(16, Math.round(1000 / this.fps))
    this.capture = new native.ScreenCapture(options)
    await this.capture.start()
    this.reading = this.read()
  }

  async read() {
    try {
      for (;;) {
        const frame = await this.capture.nextFrame()
        if (!frame) break
        // Read the native buffer once per frame; snapshot() runs on every tick and must not copy it again.
        this.latest = { buffer: frame.buffer, width: frame.width, height: frame.height, rowPitch: frame.rowPitch }
        this.seq++
        this.latestAt = this.now()
      }
      this.ended = this.ended || 'capture closed'
    } catch (error) {
      this.ended = error instanceof Error ? error.message : String(error)
    }
  }

  /** The newest frame with its packed pixels, or undefined before the first one. */
  snapshot() {
    if (!this.latest) return undefined
    return { seq: this.seq, at: this.latestAt, frame: this.latest }
  }

  async stop() {
    this.ended = this.ended || 'stopped'
    await this.capture?.stop().catch(() => {})
    await this.reading
    this.capture = null
    this.latest = null
  }
}
