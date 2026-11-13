// Bridge to the desktop overlay (Windows: overlay/overlay.ps1, WPF). JSON lines both ways.
// Other platforms have no overlay; the conversation stays in DSH.

import { spawn as spawnProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const OVERLAY_SCRIPT = fileURLToPath(new URL('../overlay/overlay.ps1', import.meta.url))

export class Overlay {
  /**
   * @param {{ title: string, statePath: string, capturable?: boolean, onMessage: (message: object) => void, platform?: string, spawn?: typeof spawnProcess, script?: string, log?: (text: string) => void }} options
   */
  constructor({ title, statePath, capturable = false, onMessage, platform = process.platform, spawn = spawnProcess, script = OVERLAY_SCRIPT, log = () => {} }) {
    this.title = title
    this.capturable = capturable
    this.statePath = statePath
    this.onMessage = onMessage
    this.platform = platform
    this.spawn = spawn
    this.script = script
    this.log = log
    this.child = null
    this.last = new Map()
  }

  get available() {
    return this.platform === 'win32'
  }

  get open() {
    return this.child !== null
  }

  /** Start the overlay process; replays the latest state so a reopened card is current. */
  show() {
    if (!this.available || this.child) return
    const child = this.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-StatePath', this.statePath, '-Title', this.title, ...(this.capturable ? ['-Capturable'] : [])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    createInterface({ input: child.stdout }).on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.type === 'ready') for (const event of this.last.values()) this.write(event)
      this.onMessage(message)
    })
    child.stderr.on('data', data => this.log(`live-sight overlay: ${String(data).trim()}`))
    child.on('error', error => this.log(`live-sight overlay could not start: ${error.message}`))
    child.on('exit', () => {
      if (this.child === child) this.child = null
    })
  }

  /** Send one event; `state` and `busy` are also kept so a restarted overlay catches up. */
  send(event) {
    if (event.type === 'state' || event.type === 'busy') this.last.set(event.type, event)
    this.write(event)
  }

  write(event) {
    if (!this.child?.stdin.writable) return
    this.child.stdin.write(`${JSON.stringify(event)}\n`)
  }

  close() {
    const child = this.child
    if (!child) return
    this.write({ type: 'close' })
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 3000)
    timer.unref?.()
    child.once('exit', () => clearTimeout(timer))
  }
}
