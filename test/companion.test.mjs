import test from 'node:test'
import assert from 'node:assert/strict'
import { Companion, observationText, SOURCE_KIND } from '../lib/companion.js'

// Test doubles: a scripted screen source, an agent that records followups, an overlay that records events.
function solid(width, height, [b, g, r]) {
  const buffer = new Uint8Array(width * height * 4)
  for (let i = 0; i < buffer.length; i += 4) { buffer[i] = b; buffer[i + 1] = g; buffer[i + 2] = r; buffer[i + 3] = 255 }
  return { buffer, width, height }
}

function harness({ status = 'idle', options = {} } = {}) {
  let clock = 0
  let seq = 0
  let current = solid(960, 540, [200, 40, 20])
  const followups = []
  const events = []
  const agent = { session: { id: 's1' }, status, followup: m => followups.push(m) }
  const source = {
    started: false,
    ended: null,
    target: { kind: 'window', title: 'Game' },
    geometry: { window: 'Game', left: 0, top: 0, width: 960, height: 540 },
    async start() { this.started = true },
    async stop() { this.started = false },
    snapshot: () => ({ seq, at: clock, frame: current }),
  }
  const companion = new Companion({
    agent,
    createSource: () => source,
    encode: rgba => Buffer.from(`jpeg:${rgba.width}x${rgba.height}`),
    saveImage: async (data, name) => ({ ref: String(data), name }),
    message: (content, kind) => ({ content, kind }),
    overlay: { show: () => events.push({ type: 'show' }), send: e => events.push(e), close: () => events.push({ type: 'close' }) },
    options: { fps: 2, minGapMs: 5000, settleMs: 1000, minSpacingMs: 400, ...options },
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
  })
  const advance = (ms, next) => { clock += ms; if (next) { current = next; seq++ } else seq++; companion.tick() }
  return { companion, agent, source, followups, events, advance, settle: () => companion.delivering || Promise.resolve(), setClock: t => { clock = t } }
}

test('a scene change becomes one sheet handed to the idle agent, labelled as the screen, not the user', async () => {
  const h = harness()
  await h.companion.start()
  assert.ok(h.source.started)
  assert.deepEqual(h.events.slice(0, 2).map(e => e.type), ['show', 'state'])
  h.advance(500)
  h.advance(500, solid(960, 540, [20, 200, 40]))
  h.advance(500)
  h.advance(600)
  await h.settle()
  assert.equal(h.followups.length, 1)
  const m = h.followups[0]
  assert.equal(m.kind, SOURCE_KIND)
  assert.match(m.content[0].text, /這是即時畫面，不是對方說的話/)
  assert.match(m.content[0].text, /視窗「Game」/)
  assert.equal(m.content[1].type, 'image')
  assert.match(m.content[1].attachment.ref, /^jpeg:896x252$/, 'two tiles side by side, 448 wide each, 16:9 at 28px')
  assert.equal(h.companion.status().sheets, 1)
})

test('nothing is handed over while the agent is speaking, and no sooner than minGap after the last sheet', async () => {
  const h = harness({ status: 'running' })
  await h.companion.start()
  h.advance(500)
  h.advance(500, solid(960, 540, [20, 200, 40]))
  h.advance(2000)
  await h.settle()
  assert.equal(h.followups.length, 0, 'agent busy')
  h.agent.status = 'idle'
  h.advance(500)
  await h.settle()
  assert.equal(h.followups.length, 1)
  h.advance(500, solid(960, 540, [200, 200, 200]))
  h.advance(2000)
  await h.settle()
  assert.equal(h.followups.length, 1, 'still inside minGap')
  h.advance(3000)
  await h.settle()
  assert.equal(h.followups.length, 2)
})

test('a still screen hands over nothing beyond the first view', async () => {
  const h = harness({ options: { maxAgeMs: 60_000 } })
  await h.companion.start()
  for (let i = 0; i < 40; i++) h.advance(500)
  await h.settle()
  assert.equal(h.followups.length, 0)
})

test('words typed in the overlay go in as the user, with the screen as it is now', async () => {
  const h = harness()
  await h.companion.start()
  h.advance(500)
  await h.companion.userSays('  這一關怎麼過？ ')
  const m = h.followups.at(-1)
  assert.equal(m.kind, 'user')
  assert.equal(m.content[0].text, '這一關怎麼過？')
  assert.equal(m.content[1].type, 'image')
  assert.match(m.content[1].attachment.ref, /^jpeg:896x504$/)
})

test('the overlay mirrors the conversation: replies, the user\'s words, and when the agent is thinking', () => {
  const h = harness()
  h.companion.onSessionEvent({ type: 'turn/start', data: { turn: 1 } })
  h.companion.onSessionEvent({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '好帥！' }] } } })
  h.companion.onSessionEvent({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '看我的' }] } })
  h.companion.onSessionEvent({ type: 'user/message', data: { source: { kind: SOURCE_KIND }, content: [{ type: 'text', text: '（這是即時畫面）' }] } })
  h.companion.onSessionEvent({ type: 'turn/end', data: { turn: 1 } })
  assert.deepEqual(h.events, [
    { type: 'busy', value: true },
    { type: 'say', role: 'assistant', id: '1.1', text: '好帥！' },
    { type: 'say', role: 'user', text: '看我的' },
    { type: 'busy', value: false },
  ])
})

test('pause stops capturing, resume starts again, a closed source stops the companion with its reason', async () => {
  const h = harness()
  await h.companion.start()
  await h.companion.pause()
  assert.equal(h.companion.state, 'paused')
  assert.equal(h.source.started, false)
  await h.companion.resume()
  assert.equal(h.companion.state, 'watching')
  h.source.ended = 'capture closed'
  h.advance(500)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(h.companion.state, 'stopped')
  assert.deepEqual(h.events.at(-1), { type: 'close' })
  assert.match(h.events.at(-2).detail, /capture closed/)
})

test('the observation text states order, span and that staying quiet is fine', () => {
  const text = observationText({ target: { kind: 'screen', monitor: 1 }, frames: 4, now: true, spanMs: 12_400 })
  assert.match(text, /主螢幕/)
  assert.match(text, /共 4 格/)
  assert.match(text, /最後一格是現在/)
  assert.match(text, /約 12 秒/)
  assert.match(text, /也可以不說/)
  assert.match(observationText({ target: { kind: 'window', title: 'X' }, frames: 1, now: false, spanMs: 0 }), /一格，是現在的畫面/)
  assert.doesNotMatch(text, /灰色斜線/)
  assert.match(observationText({ target: { kind: 'screen', monitor: 1 }, frames: 5, now: false, spanMs: 9000, empty: 1 }), /灰色斜線的格子是空格，不是畫面/)
  assert.doesNotMatch(text, /省略/)
  assert.match(observationText({ target: { kind: 'screen', monitor: 1 }, frames: 6, now: true, spanMs: 90_000, dropped: 10 }), /另外省略了 10 個畫面/)
})

test('a sheet that ends on the screen as it is now still has at most maxFrames tiles', async () => {
  const h = harness({ status: 'running', options: { maxFrames: 4, minGapMs: 0, motionQuota: 0.0001, cellThreshold: 1 } })
  await h.companion.start()
  const shade = v => solid(960, 540, [v, v, v])
  for (let i = 1; i <= 8; i++) h.advance(800, shade(i % 2 ? 200 : 20))
  // A small change too soon after the last kept frame to be kept itself: the sheet should end on it.
  h.advance(100, solid(960, 540, [60, 20, 20]))
  h.agent.status = 'idle'
  h.advance(50)
  await h.settle()
  const m = h.followups.at(-1)
  assert.match(m.content[0].text, /共 4 格/)
  assert.match(m.content[0].text, /最後一格是現在/)
  assert.match(m.content[1].attachment.ref, /^jpeg:896x504$/, '2×2, no empty cell')
})

test('a scene change right after a kept frame is still shown once the screen goes still', async () => {
  const h = harness({ options: { minGapMs: 0, settleMs: 1000, minSpacingMs: 700 } })
  await h.companion.start()
  h.advance(500)
  h.advance(800, solid(960, 540, [20, 200, 40]))
  // The next scene arrives 300 ms later, too soon to be kept; after that Windows sends no more frames.
  h.advance(300, solid(960, 540, [200, 200, 200]))
  for (let i = 0; i < 6; i++) { h.setClock(1600 + (i + 1) * 500); h.companion.tick() }
  await h.settle()
  const sheets = h.followups.filter(m => m.kind === SOURCE_KIND)
  assert.ok(sheets.length >= 1)
  assert.equal(h.companion.selector.pendingCut, false, 'the pending scene change was kept')
  const tiles = sheets.reduce((n, m) => n + Number(/共 (\d+) 格/.exec(m.content[0].text)?.[1] || 1), 0)
  assert.equal(tiles, 3, 'first view, the green scene and the white one')
})

test('a sheet whose frames left the selector is not lost when the agent gets busy while it is saved', async () => {
  const h = harness()
  const save = h.companion.saveImage
  h.companion.saveImage = async (data, name) => { h.agent.status = 'running'; return save(data, name) }
  await h.companion.start()
  h.advance(500)
  h.advance(500, solid(960, 540, [20, 200, 40]))
  h.advance(1200)
  await h.settle()
  assert.equal(h.followups.length, 1, 'queued for the next turn instead of dropped')
})

test('with maxFrames 1 a sheet that ends on the screen now has one tile', async () => {
  const h = harness({ status: 'running', options: { maxFrames: 1, minGapMs: 0 } })
  await h.companion.start()
  h.advance(500)
  h.advance(100, solid(960, 540, [20, 200, 40]))
  h.agent.status = 'idle'
  h.advance(50)
  await h.settle()
  const m = h.followups.at(-1)
  assert.match(m.content[1].attachment.ref, /^jpeg:448x252$/)
})

test('a reply appears in the overlay while it is written, and the final text settles the same bubble', async () => {
  const h = harness({ options: { streamIntervalMs: 5 } })
  const chunk = text => ({ type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text } })
  h.companion.onStream({ type: 'start', attemptId: 'a1', revision: 1, turn: 3, step: 2 })
  h.companion.onStream({ type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'hidden' } })
  h.companion.onStream(chunk('紅龍'))
  h.companion.onStream(chunk('來了'))
  await new Promise(r => setTimeout(r, 20))
  h.companion.onStream(chunk('！'))
  h.companion.onSessionEvent({ type: 'assistant/message', data: { turn: 3, step: 2, message: { content: [{ type: 'text', text: '紅龍來了！' }] } } })
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(h.events, [
    { type: 'stream', id: '3.2', text: '紅龍來了' },
    { type: 'say', role: 'assistant', id: '3.2', text: '紅龍來了！' },
  ], 'reasoning never shows; no stream frame after the final text')
})

test('the other party speaking stops a turn that only looks at the screen, never one that answers them', async () => {
  const calls = []
  const h = harness({ status: 'running' })
  h.agent.cancel = (cause, options) => calls.push(['cancel', cause, options])
  h.agent.inbox = { remove: id => { calls.push(['remove', id]); return true } }
  const words = { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '你看這裡' }] }
  h.companion.onSessionEvent({ type: 'turn/start', data: { turn: 1 } })
  h.companion.onSessionEvent({ type: 'user/message', data: { source: { kind: SOURCE_KIND }, content: [] } })
  assert.equal(h.companion.onInboxInserted({ source: { kind: 'live-sight' } }), false, 'a sheet does not preempt')
  assert.equal(h.companion.onInboxInserted(words), true)
  assert.equal(h.companion.onInboxInserted(words), false, 'sending the words again does not cancel twice')
  await Promise.resolve()
  assert.deepEqual(calls, [['remove', 'm1'], ['cancel', { kind: 'user' }, { keepInbox: true }]])
  assert.deepEqual(h.followups.at(-1), { content: words.content, kind: 'user' }, 'their words are sent again after the cancel')
  h.companion.onSessionEvent({ type: 'turn/end', data: { turn: 1 } })
  h.companion.onSessionEvent({ type: 'turn/start', data: { turn: 2 } })
  h.companion.onSessionEvent({ type: 'user/message', data: words })
  assert.equal(h.companion.onInboxInserted(words), false, 'a turn answering them is not cut short')
  h.companion.onSessionEvent({ type: 'turn/start', data: { turn: 3 } })
  h.companion.onSessionEvent({ type: 'user/message', data: { source: { kind: 'temir-thought' }, content: [] } })
  assert.equal(h.companion.onInboxInserted(words), false, 'only screen-only turns give way')
  assert.equal(h.companion.status().preempted, 1)
})

test('a reply that streamed but was never recorded is settled at the end of the turn', async () => {
  const h = harness({ options: { streamIntervalMs: 1 } })
  h.companion.onStream({ type: 'start', attemptId: 'a9', revision: 1, turn: 4, step: 1 })
  h.companion.onStream({ type: 'chunk', attemptId: 'a9', revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: '牠的尾巴' } })
  await new Promise(r => setTimeout(r, 10))
  h.companion.onSessionEvent({ type: 'turn/end', data: { turn: 4 } })
  assert.deepEqual(h.events, [
    { type: 'stream', id: '4.1', text: '牠的尾巴' },
    { type: 'say', role: 'assistant', id: '4.1', text: '牠的尾巴…' },
    { type: 'busy', value: false },
  ])
  assert.equal(h.companion.streams.size, 0)
})

test('an interrupted reply keeps what was said and shows that it was cut', () => {
  const h = harness()
  h.companion.onSessionEvent({ type: 'assistant/message', data: { turn: 1, step: 1, interrupted: true, message: { content: [{ type: 'text', text: '紅龍好像' }] } } })
  assert.deepEqual(h.events, [{ type: 'say', role: 'assistant', id: '1.1', text: '紅龍好像…' }])
})
