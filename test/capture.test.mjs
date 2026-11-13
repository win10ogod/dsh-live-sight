import test from 'node:test'
import assert from 'node:assert/strict'
import { ScreenSource, currentGeometry, resolveTarget } from '../lib/capture.js'

// Test double of @screen-capture/node: two windows, one of which can move or come to the front.
function fakeNative() {
  const windows = {
    7: { handle: 7, title: 'Game', processName: 'game.exe', isValid: true, rect: { left: 100, top: 50, right: 1060, bottom: 590 } },
    9: { handle: 9, title: 'DSH', processName: 'dsh.exe', isValid: true, rect: { left: 0, top: 0, right: 800, bottom: 600 } },
  }
  let front = 7
  let reads = 0
  const frames = [{ width: 2, height: 1, rowPitch: 8, get buffer() { reads++; return new Uint8Array(8) } }]
  return {
    windows,
    bringToFront: handle => { front = handle },
    get bufferReads() { return reads },
    foregroundWindow: () => windows[front],
    windowFromHandle: handle => windows[handle] ?? { isValid: false },
    windowFromContainsName: title => Object.values(windows).find(w => w.title.includes(title)) ?? { isValid: false },
    monitorFromIndex: () => ({ width: 1920, height: 1080 }),
    isSupported: () => true,
    captureApiSupport: () => ({}),
    ScreenCapture: class {
      async start() {}
      async stop() { frames.length = 0 }
      async nextFrame() { await new Promise(r => setTimeout(r, 5)); return frames.shift() ?? null }
    },
  }
}

test('foreground resolves to a window by handle, and the handle keeps pointing at it after focus moves', () => {
  const native = fakeNative()
  const first = resolveTarget(native, { kind: 'foreground' })
  assert.deepEqual(first.target, { kind: 'window', title: 'Game', handle: 7 })
  native.bringToFront(9)
  const again = resolveTarget(native, first.target)
  assert.equal(again.options.windowHandle, 7, 'resuming watches the same window, not the one now in front')
})

test('current geometry follows a window that moved', () => {
  const native = fakeNative()
  const { target } = resolveTarget(native, { kind: 'window', title: 'Ga' })
  native.windows[7].rect = { left: 400, top: 50, right: 1360, bottom: 590 }
  assert.equal(currentGeometry(native, target).left, 400)
  assert.equal(currentGeometry(native, { kind: 'screen', monitor: 1 }), null)
})

test('each frame\'s native buffer is read once, however often it is looked at', async () => {
  const native = fakeNative()
  const source = new ScreenSource({ target: { kind: 'window', title: 'Game' }, fps: 2, native })
  await source.start()
  await new Promise(r => setTimeout(r, 30))
  for (let i = 0; i < 10; i++) assert.ok(source.snapshot())
  assert.equal(native.bufferReads, 1)
  await source.stop()
})

test('the frame origin leaves out the invisible borders Windows counts in a window rectangle', async () => {
  const { frameOrigin } = await import('../lib/capture.js')
  // Measured: a 960×540 window at (60, 60) gave a 946×533 frame.
  assert.deepEqual(frameOrigin({ left: 60, top: 60, width: 960, height: 540 }, { width: 946, height: 533 }), { left: 67, top: 60 })
  // Maximized, borders on every side (worked out, not measured).
  assert.deepEqual(frameOrigin({ left: -8, top: -8, width: 1936, height: 1048 }, { width: 1920, height: 1032 }), { left: 0, top: 0 })
  assert.equal(frameOrigin({ monitor: 1, width: 1920, height: 1080 }, { width: 1920, height: 1080 }), null)
})

test('a closed window is reported as gone, not as a native error', () => {
  const native = { ...fakeNativeThrowing() }
  assert.throws(() => resolveTarget(native, { kind: 'window', title: 'Game', handle: 7 }), /the window "Game" is gone/)
  assert.equal(currentGeometry(native, { kind: 'window', title: 'Game', handle: 7 }), null)
})

function fakeNativeThrowing() {
  return { windowFromHandle: () => { throw new Error('A Windows API call failed: invalid window handle (0x80070578)') } }
}
