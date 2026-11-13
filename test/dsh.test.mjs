import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Loop from '@deepseek-ai/dsh-agent-loop'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import Commands from '@deepseek-ai/dsh-commands'
import * as sight from '../lib/index.js'

// A real DSH composition; only the model, the screen and the overlay are test doubles.
function solid(width, height, [b, g, r]) {
  const buffer = new Uint8Array(width * height * 4)
  for (let i = 0; i < buffer.length; i += 4) { buffer[i] = b; buffer[i + 1] = g; buffer[i + 2] = r; buffer[i + 3] = 255 }
  return { buffer, width, height }
}

async function fixture(t, { modalities, efforts, config = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'live-sight-'))
  const ctx = new Context()
  for (const plugin of [Sessions, Projections, Agents, Llm, Prompt, Tools, NativeToolExecutor, Commands]) await ctx.plugin(plugin)
  await ctx.plugin(AttachmentLocal, { dshHome: home })
  await ctx.plugin(Loop, {})
  const requests = []
  const reply = { text: '我看到了。', hold: null }
  const adapter = new (class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, ...(modalities ? { inputModalities: modalities } : {}), ...(efforts ? { reasoning: { efforts: efforts.map(id => ({ id, name: id })) } } : {}) } }
    async *stream(request) {
      requests.push(request)
      if (reply.call && !request.messages.some(m => m.role === 'tool')) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'sight', arguments: JSON.stringify(reply.call) } }
      } else {
        // Streamed like a real provider: the text arrives in pieces before the block ends.
        yield { type: 'block-start', index: 0, blockType: 'text' }
        const half = Math.ceil(reply.text.length / 2)
        yield { type: 'text-delta', index: 0, text: reply.text.slice(0, half) }
        if (reply.hold) await reply.hold(request.signal)
        yield { type: 'text-delta', index: 0, text: reply.text.slice(half) }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })()
  ctx.llm.registerAdapter(['fixture'], adapter)

  const screen = { frame: solid(960, 540, [200, 40, 20]), seq: 1, at: 0 }
  const overlayEvents = []
  const overlays = []
  const sleeps = []
  const events = []
  ctx.on('session/event', (_session, event) => events.push(event))
  const source = {
    target: { kind: 'window', title: 'Game' },
    geometry: { window: 'Game', left: 100, top: 50, width: 960, height: 540 },
    ended: null,
    async start() {},
    async stop() {},
    snapshot: () => ({ ...screen }),
  }
  let clock = 0
  const deps = {
    createSource: () => source,
    createOverlay: settings => { overlays.push(settings); return { show: () => overlayEvents.push({ type: 'show' }), send: e => overlayEvents.push(e), close: () => overlayEvents.push({ type: 'close' }) } },
    now: () => clock,
    sleep: async ms => { sleeps.push(ms) },
  }
  // cordis reserves the third argument of ctx.plugin; hand the doubles over through apply.
  await ctx.plugin({ name: sight.name, inject: sight.inject, apply: (c, config) => sight.apply(c, config, deps) }, { overlayTitle: '測試', minGapMs: 0, settleMs: 0, fps: 20, ...config })
  const handle = await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'fixture-model', maxTokens: 4096 } })
  t.after(async () => {
    await handle.dispose()
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const change = (frame, ms) => { clock += ms; screen.frame = frame; screen.seq++; screen.at = clock }
  const run = async text => (await ctx.commands.execute(handle.agent, text, [], new AbortController().signal)).result
  return { ctx, agent: handle.agent, source, requests, reply, overlayEvents, overlays, sleeps, events, run, change, tick: ms => { clock += ms } }
}

const textOf = content => (Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : String(content ?? ''))
const waitFor = async (check, ms = 5000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 20))
  return check()
}

test('the agent can look at the screen and gets the image with a pixel mapping', async t => {
  const f = await fixture(t)
  assert.ok(f.ctx.tools.get('sight', f.agent), 'sight is a tool of the agent')
  f.reply.call = { action: 'look', target: 'window Game' }
  f.agent.followup(createUserMessage({ content: [{ type: 'text', text: '幫我看一下畫面' }], source: { kind: 'user' } }))
  await f.agent.whenIdle()
  const toolMessage = f.requests.at(-1).messages.find(m => m.role === 'tool')
  assert.ok(toolMessage, 'the tool result reached the model')
  const result = JSON.parse(textOf(toolMessage.content))
  assert.deepEqual(result.image, { width: 952, height: 532 }, 'look width capped at the 960-pixel window, snapped to 28')
  assert.equal(result.geometry.left, 100)
  assert.ok(Math.abs(result.scale.x - 960 / 952) < 1e-9)
  assert.ok(toolMessage.content.some(b => b.type === 'image'), 'the screen image is part of the tool result')
})

test('/sight starts watching; a scene change reaches the conversation as a live-sight sheet and the reply reaches the overlay', async t => {
  const f = await fixture(t)
  const result = await f.ctx.commands.execute(f.agent, '/sight window Game', [], new AbortController().signal)
  assert.equal(result.result.kind, 'success', JSON.stringify(result.result))
  assert.match(result.result.text, /視窗「Game」/)
  assert.deepEqual(f.overlayEvents.slice(0, 2).map(e => e.type), ['show', 'state'])
  await new Promise(r => setTimeout(r, 120))
  f.change(solid(960, 540, [20, 200, 40]), 1000)
  assert.ok(await waitFor(() => f.requests.length > 0), 'the sheet woke the agent')
  await f.agent.whenIdle()
  const user = f.requests[0].messages.filter(m => m.role === 'user')
  const sheet = user.find(m => /這是即時畫面/.test(textOf(m.content)))
  assert.ok(sheet, 'the observation is in the request')
  assert.ok(sheet.content.some(b => b.type === 'image'), 'with the sheet image')
  assert.ok(await waitFor(() => f.overlayEvents.some(e => e.type === 'say' && e.text === '我看到了。')), JSON.stringify(f.overlayEvents))
  const stopped = await f.ctx.commands.execute(f.agent, '/sight off', [], new AbortController().signal)
  assert.equal(stopped.result.kind, 'success')
  assert.deepEqual(f.overlayEvents.at(-1), { type: 'close' })
})

test('a model that only reads text is refused with a plain reason before anything is captured', async t => {
  const f = await fixture(t, { modalities: ['text'] })
  const result = await f.ctx.commands.execute(f.agent, '/sight', [], new AbortController().signal)
  assert.equal(result.result.kind, 'error')
  assert.match(result.result.text, /不接受圖片/)
  assert.equal(f.overlayEvents.length, 0)
})

test('switching targets: the old card closing does not stop the new watch', async t => {
  const f = await fixture(t)
  assert.equal((await f.run('/sight window Game')).kind, 'success')
  assert.equal((await f.run('/sight screen')).kind, 'success')
  assert.equal(f.overlays.length, 2)
  // The first card's PowerShell exits after it was closed and reports it; then a stale stop click arrives.
  f.overlays[0].onMessage({ type: 'closed' })
  f.overlays[0].onMessage({ type: 'stop' })
  await new Promise(r => setTimeout(r, 20))
  assert.match((await f.run('/sight status')).text, /"state":"watching"/)
  f.overlays[1].onMessage({ type: 'stop' })
  await new Promise(r => setTimeout(r, 20))
  assert.match((await f.run('/sight status')).text, /"state":"stopped"/)
})

test('/sight foreground waits for the user to bring the window forward', async t => {
  const f = await fixture(t)
  assert.equal((await f.run('/sight foreground')).kind, 'success')
  assert.deepEqual(f.sleeps, [3000])
  assert.equal((await f.run('/sight off')).kind, 'success')
  await f.run('/sight window Game')
  assert.deepEqual(f.sleeps, [3000], 'a named window needs no wait')
})

test('/sight pause and resume say so when there is nothing to pause or resume', async t => {
  const f = await fixture(t)
  assert.equal((await f.run('/sight pause')).kind, 'error')
  assert.equal((await f.run('/sight resume')).kind, 'error')
  await f.run('/sight window Game')
  assert.equal((await f.run('/sight resume')).kind, 'error', 'already watching')
  assert.equal((await f.run('/sight pause')).kind, 'success')
  assert.equal((await f.run('/sight resume')).kind, 'success')
  await f.run('/sight off')
})

test('a screen-only turn gives way when the user types; their words are answered next, the reply streams to the overlay', async t => {
  const f = await fixture(t)
  // The first (screen) turn stalls halfway through its reply until it is cancelled.
  f.reply.text = '紅龍出現了，好大'
  f.reply.hold = signal => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  assert.equal((await f.run('/sight window Game')).kind, 'success')
  await new Promise(r => setTimeout(r, 120))
  f.change(solid(960, 540, [20, 200, 40]), 1000)
  assert.ok(await waitFor(() => f.requests.length === 1 && f.agent.status === 'running'), 'the screen turn is running')
  assert.ok(await waitFor(() => f.overlayEvents.some(e => e.type === 'stream' && e.text === '紅龍出現')), 'its first half streamed: ' + JSON.stringify(f.overlayEvents))
  f.reply.hold = null
  f.reply.text = '在左邊喔。'
  f.agent.followup(createUserMessage({ content: [{ type: 'text', text: '牠在哪？' }], source: { kind: 'user' } }))
  await waitFor(() => f.requests.length >= 2)
  await f.agent.whenIdle()
  assert.equal(f.requests.length, 2, 'no second screen turn was needed before answering')
  assert.deepEqual(f.events.filter(e => e.type === 'turn/end').map(e => e.data.reason.kind), ['aborted', 'completed'])
  const asked = f.requests[1].messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n')
  assert.match(asked, /牠在哪/)
  assert.ok(await waitFor(() => f.overlayEvents.some(e => e.type === 'say' && e.text === '在左邊喔。')))
  assert.ok(f.overlayEvents.some(e => e.type === 'say' && e.text === '紅龍出現…'), 'the cut reply is kept and marked: ' + JSON.stringify(f.overlayEvents.filter(e => e.type === 'say')))
  assert.match((await f.run('/sight status')).text, /"preempted":1/)
  await f.run('/sight off')
})

test('watchEffort lowers the reasoning effort while watching and gives it back when watching stops', async t => {
  const f = await fixture(t, { efforts: ['low', 'medium', 'xhigh'], config: { watchEffort: 'low' } })
  f.agent.model.select({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'xhigh' })
  await f.run('/sight window Game')
  assert.equal(f.agent.model.current().reasoningEffort, 'low')
  assert.match((await f.run('/sight status')).text, /"effort":"low","restoresTo":"xhigh"/)
  await f.run('/sight off')
  assert.equal(f.agent.model.current().reasoningEffort, 'xhigh')
  // Someone picks another effort while watching: it is theirs, nothing is put back over it.
  await f.run('/sight window Game')
  f.agent.model.select({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'medium' })
  await f.run('/sight off')
  assert.equal(f.agent.model.current().reasoningEffort, 'medium')
  // The watched window closes by itself: the effort comes back too.
  f.agent.model.select({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'xhigh' })
  await f.run('/sight window Game')
  f.source.ended = 'capture closed'
  assert.ok(await waitFor(() => f.agent.model.current().reasoningEffort === 'xhigh'), 'restored after the source ended')
  f.source.ended = null
})

test('watchEffort that the model does not offer leaves the effort alone', async t => {
  const f = await fixture(t, { efforts: ['high'], config: { watchEffort: 'low' } })
  f.agent.model.select({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' })
  await f.run('/sight window Game')
  assert.equal(f.agent.model.current().reasoningEffort, 'high')
  await f.run('/sight off')
})
