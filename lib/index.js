// DSH plugin entry: the `sight` tool, the `/sight` command, and one live companion at a time.

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Companion, COMPANION_DEFAULTS } from './companion.js'
import { ScreenSource, currentGeometry, describeTarget, frameOrigin, listWindows, loadNative, parseTarget } from './capture.js'
import { Overlay } from './overlay.js'
import { SELECT_DEFAULTS } from './select.js'
import { SHEET_DEFAULTS, downscale, fitSize } from './sheet.js'

export const name = 'live-sight'
export const inject = ['agents', 'attachments', 'tools', 'llm']

export const Config = z.object({
  fps: z.number().min(0.2).max(10).default(COMPANION_DEFAULTS.fps).description('Frames sampled per second while watching.'),
  minGapMs: z.number().step(1).min(0).default(COMPANION_DEFAULTS.minGapMs).description('Shortest time between two sheets handed to the model.'),
  maxFrames: z.number().step(1).min(1).max(9).default(SELECT_DEFAULTS.maxFrames).description('Frames per sheet.'),
  maxAgeMs: z.number().step(1).min(1000).default(SELECT_DEFAULTS.maxAgeMs).description('A sheet is ready once its oldest frame is this old.'),
  settleMs: z.number().step(1).min(0).default(SELECT_DEFAULTS.settleMs).description('After a scene change, wait this long without another one.'),
  motionQuota: z.number().min(0).default(SELECT_DEFAULTS.motionQuota).description('Accumulated change that earns a frame during motion.'),
  cutCoverage: z.number().min(0).max(1).default(SELECT_DEFAULTS.cutCoverage).description('Share of the screen that must change for a scene change.'),
  tileWidth: z.number().step(1).min(112).default(SHEET_DEFAULTS.tileWidth).description('Width of one tile in a sheet.'),
  align: z.number().step(1).min(1).default(SHEET_DEFAULTS.align).description('Image patch size of the vision model; image sizes are multiples of it.'),
  lookWidth: z.number().step(1).min(224).default(1344).description('Width of the image returned by sight look.'),
  attachWidth: z.number().step(1).min(224).default(COMPANION_DEFAULTS.attachWidth).description('Width of the screen image sent with words typed in the overlay.'),
  userFirst: z.boolean().default(COMPANION_DEFAULTS.userFirst).description('When the user speaks during a turn that only looks at the screen, stop that turn and answer the user at once.'),
  overlay: z.boolean().default(true).description('Show the desktop overlay while watching (Windows).'),
  overlayTitle: z.string().default('Live Sight').description('Title shown on the overlay, for example the companion\'s name.'),
  overlayCapturable: z.boolean().default(false).description('Let screen captures (the agent\'s own view, recorders, screen sharing) see the overlay.'),
  foregroundDelayMs: z.number().step(1).min(0).default(3000).description('With the target "foreground", wait this long so the user can bring the window to watch to the front.'),
  watchEffort: z.string().default('').description('Reasoning effort of the conversation while watching (for example "low"), restored when watching stops; empty keeps the conversation\'s own.'),
})

const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) })
const region = object({ x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, ['x', 'y', 'width', 'height'])

const output = {
  schema: { type: 'object' },
  render(_args, value) {
    const { attachment, ...rest } = value
    return [{ type: 'text', text: JSON.stringify(rest, null, 2) }, ...(attachment ? [{ type: 'image', attachment }] : [])]
  },
}

const errorText = error => (error instanceof Error ? error.message : String(error))

export function apply(ctx, config = {}, deps = {}) {
  const options = { ...COMPANION_DEFAULTS, ...SELECT_DEFAULTS, ...SHEET_DEFAULTS, lookWidth: 1344, overlay: true, overlayTitle: 'Live Sight', overlayCapturable: false, foregroundDelayMs: 3000, watchEffort: '', ...config }
  const native = deps.native ? async () => deps.native : loadNative
  const now = deps.now || Date.now
  const log = text => ctx.logger?.warn?.(text)
  const stateDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'live-sight')
  let companion = null

  const encode = async rgba => {
    const m = await native()
    return new m.ImageEncoder('jpeg', 'rgba8').encode(Buffer.from(rgba.pixels.buffer, rgba.pixels.byteOffset, rgba.pixels.byteLength), rgba.width, rgba.height)
  }
  const saveImage = (data, fileName) => ctx.attachments.saveImage({ data, mediaType: 'image/jpeg', name: fileName })
  const message = (content, kind) => createUserMessage({ content, source: { kind } })
  const sourceFor = target => (deps.createSource ? deps.createSource(target) : new ScreenSource({ target, fps: options.fps, native: deps.native }))
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  /** `foreground` means the window in front once the user has had a moment to switch to it from DSH. */
  const settle = async target => { if (target.kind === 'foreground' && options.foregroundDelayMs > 0) await sleep(options.foregroundDelayMs) }

  /** The model of this conversation has to read images; say so plainly instead of failing later. */
  async function requireVision(agent) {
    const selection = agent.model?.current?.()
    if (!selection?.provider || !selection?.model) return null
    const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
    if (info.inputModalities && !info.inputModalities.includes('image')) {
      throw new Error(`目前這段對話的模型（${selection.provider}/${selection.model}）不接受圖片，無法看畫面。請換成能看圖的模型，例如 deepseek-flash 或宣告了 image 輸入的本地模型。`)
    }
    return info
  }

  /**
   * Watching asks for quick reactions: with `watchEffort` the conversation reasons at that effort until
   * watching stops. Measured with a local model (2026-11-13): a screen reply started about 32 s into its
   * turn at xhigh and 8-11 s at low; an answer to the user 59 s and 33 s after they typed.
   */
  function lowerEffort(agent, info) {
    const wanted = options.watchEffort
    if (!wanted) return null
    const before = agent.model?.current?.()
    if (!before || before.reasoningEffort === wanted) return null
    const offered = info?.reasoning?.efforts?.map(e => e.id)
    if (offered && !offered.includes(wanted)) {
      log(`live-sight: watchEffort "${wanted}" is not offered by ${before.provider}/${before.model} (${offered.join(', ')}); the effort stays as it is`)
      return null
    }
    const applied = { ...before, reasoningEffort: wanted }
    agent.model.select(applied)
    return { before: { ...before }, applied }
  }

  /** Give the conversation its own effort back, unless someone chose another model or effort meanwhile. */
  function restoreEffort(agent, effort) {
    if (!effort) return
    const now = agent.model?.current?.()
    if (now && now.provider === effort.applied.provider && now.model === effort.applied.model && now.reasoningEffort === effort.applied.reasoningEffort) agent.model.select(effort.before)
  }

  /** An overlay acts only for the companion it was opened for: a closing old card must not stop a new one. */
  function overlayFor(owner) {
    if (!options.overlay) return { show() {}, send() {}, close() {} }
    const settings = {
      title: options.overlayTitle,
      statePath: join(stateDir, 'overlay.json'),
      capturable: options.overlayCapturable,
      log,
      onMessage: message => void onOverlay(message, owner()).catch(error => log(`live-sight: overlay action failed: ${errorText(error)}`)),
    }
    return deps.createOverlay ? deps.createOverlay(settings) : new Overlay(settings)
  }

  async function onOverlay(message, owner) {
    const current = companion
    if (!current || current !== owner) return
    if (message.type === 'send') await current.userSays(message.text)
    else if (message.type === 'pause') await current.pause()
    else if (message.type === 'resume') await current.resume()
    else if (message.type === 'stop' || (message.type === 'closed' && current.state !== 'stopped')) await stop()
  }

  async function start(agent, targetText) {
    if (agent.session.header?.origin === 'subagent') throw new Error('子代理不能開始陪看')
    const info = await requireVision(agent)
    const target = parseTarget(targetText)
    if (companion?.state === 'paused' && companion.agent === agent && !targetText) {
      await companion.resume()
      return companion.status()
    }
    if (companion) await stop()
    await settle(target)
    let next
    // After the first start the resolved target (a window by its handle) is used, so resuming keeps the same window.
    next = new Companion({
      agent, createSource: () => sourceFor(next.target || target), encode, saveImage, message, overlay: overlayFor(() => next), options, now, log,
      onStop: () => { restoreEffort(agent, next.effort); next.effort = null },
    })
    companion = next
    try {
      await next.start()
    } catch (error) {
      companion = null
      throw new Error(`無法開始看${describeTarget(target)}：${errorText(error)}`)
    }
    next.effort = lowerEffort(agent, info)
    return next.status()
  }

  async function stop() {
    const current = companion
    companion = null
    if (current) await current.stop()
    return { state: 'stopped' }
  }

  /** One image of the screen now, for looking closely or before operating the computer. */
  async function look(agent, args) {
    const own = companion?.agent === agent && companion.state === 'watching' && !args.target ? companion.latest : null
    let shot = own
    let target = own ? companion.target : parseTarget(args.target)
    // The window may have moved since watching began; the mapping to screen pixels needs where it is now.
    let geometry = own ? (target?.handle ? currentGeometry(await native(), target) : null) ?? companion.source?.geometry ?? null : null
    if (!shot) {
      await settle(target)
      const source = sourceFor(target)
      await source.start()
      try {
        for (let i = 0; i < 60 && !shot; i++) {
          shot = source.snapshot()
          if (!shot) await new Promise(resolve => setTimeout(resolve, 50))
        }
        geometry = source.geometry
        target = source.target
      } finally {
        await source.stop()
      }
      if (!shot) throw new Error(`${describeTarget(target)}沒有送出畫面`)
    }
    const frame = shot.frame
    const area = args.region ? clampRegion(args.region, frame) : null
    const sourceWidth = area ? area.width : frame.width
    const sourceHeight = area ? area.height : frame.height
    const image = downscale(frame, { ...fitSize(sourceWidth, sourceHeight, args.width || options.lookWidth, options.align), region: area || undefined })
    const attachment = await saveImage(await encode(image), 'live-sight-look.jpg')
    return {
      target: describeTarget(target),
      geometry,
      frame: { width: frame.width, height: frame.height },
      frameOrigin: frameOrigin(geometry, frame),
      region: area,
      image: { width: image.width, height: image.height },
      scale: { x: sourceWidth / image.width, y: sourceHeight / image.height },
      howToMap: 'frame pixel = region origin + image pixel × scale; for a window, screen pixel = frameOrigin + frame pixel; for a screen, the frame pixel is the pixel on that monitor',
      attachment,
    }
  }

  ctx.tools.register({
    name: 'sight',
    description: [
      'See the screen. look: one image of the screen now (use it before operating the computer; `scale` maps image pixels back to the frame).',
      'start: keep watching together with the user in this conversation — sheets of what changed arrive as live-sight messages, never as the user\'s words; you may stay quiet.',
      'target: "screen", "screen 2", "window <title>" or "foreground"; windows lists window titles. stop/pause/resume/status control watching.',
    ].join(' '),
    parameters: object({
      action: { type: 'string', enum: ['look', 'start', 'stop', 'pause', 'resume', 'status', 'windows'] },
      target: { type: 'string', description: 'screen | screen <n> | window <title> | foreground' },
      region: { ...region, description: 'look only: crop in frame pixels' },
      width: { type: 'integer', minimum: 224, description: 'look only: image width' },
    }, ['action']),
    output,
    async execute(args, execution) {
      const agent = execution.agent
      switch (args.action) {
        case 'look': return look(agent, args)
        case 'start': return start(agent, args.target)
        case 'stop': return stop()
        case 'pause': await companion?.pause(); return companion?.status() ?? { state: 'stopped' }
        case 'resume': await companion?.resume(); return companion?.status() ?? { state: 'stopped', note: 'nothing to resume; use start' }
        case 'windows': return { windows: listWindows(await native()) }
        default: return companion?.status() ?? { state: 'stopped' }
      }
    },
  })

  const commands = ctx.get('commands')
  if (commands) {
    commands.register({
      name: 'sight',
      description: '陪你一起看螢幕：/sight、/sight window <標題>、/sight foreground、/sight pause、/sight resume、/sight off、/sight status',
      input: { hint: '[window <標題> | screen <n> | foreground | pause | resume | off | status]' },
      handler: async ({ agent, rawInput }) => {
        const words = String(rawInput || '').trim()
        try {
          if (/^(off|stop)$/i.test(words)) { await stop(); return { kind: 'success', text: '已停止陪看。' } }
          if (/^pause$/i.test(words)) {
            if (companion?.state !== 'watching') return { kind: 'error', text: `現在沒有在看${stoppedReason()}。` }
            await companion.pause()
            return { kind: 'success', text: '已暫停觀看。' }
          }
          if (/^resume$/i.test(words)) {
            if (companion?.state !== 'paused') return { kind: 'error', text: companion?.state === 'watching' ? '已經在看了。' : `現在沒有暫停中的陪看${stoppedReason()}，用 /sight 重新開始。` }
            await companion.resume()
            return { kind: 'success', text: '繼續觀看。' }
          }
          if (/^status$/i.test(words)) return { kind: 'success', text: JSON.stringify(companion?.status() ?? { state: 'stopped' }) }
          const status = await start(agent, words)
          return { kind: 'success', text: `開始陪你看${status.target}。` }
        } catch (error) {
          return { kind: 'error', text: errorText(error) }
        }
      },
    })
  }

  /** Why the last companion stopped, when it stopped on its own (its window closed, capture failed). */
  function stoppedReason() {
    return companion?.state === 'stopped' && companion.stats.error ? `（${companion.stats.error}）` : ''
  }

  ctx.on('session/event', (session, event) => {
    if (companion && session.id === companion.sessionId) companion.onSessionEvent(event)
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (companion?.agent === agent && companion.state !== 'stopped') companion.onStream(frame)
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (companion?.agent === agent && companion.state !== 'stopped' && companion.onInboxInserted(message)) ctx.logger?.info?.('live-sight: the user spoke; a screen-only turn gave way')
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (companion?.agent === agent) void stop()
  })
  ctx.effect(() => async () => {
    await stop()
  })
}

function clampRegion(r, frame) {
  const x = Math.min(Math.max(0, r.x), frame.width - 1)
  const y = Math.min(Math.max(0, r.y), frame.height - 1)
  return { x, y, width: Math.max(1, Math.min(r.width, frame.width - x)), height: Math.max(1, Math.min(r.height, frame.height - y)) }
}
