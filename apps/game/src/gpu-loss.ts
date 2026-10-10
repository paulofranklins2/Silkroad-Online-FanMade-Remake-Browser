/**
 * Graphics device loss (the 2026-10-05 black screen: a long grinding session in Chrome on WebGPU, then the 3D view black
 * for good while the HTML HUD kept working).
 *
 * WebGPU: Chrome loses the device when its GPU process crashes, runs out of memory or the driver resets (TDR). Babylon
 * 9.28 then "restores" it in place, and that restore cannot work: it rebuilds every buffer, texture and pipeline before
 * the new device exists (AbstractEngine._restoreEngineAfterContextLost does not await WebGPU's async initAsync), logs
 * "context successfully restored", and every later frame draws with objects of the dead device. Waiting for the new
 * device first is not enough either (measured: geometry buffers of the old device stay referenced, and the world's raw
 * texture arrays and compute resources have no CPU copy). So on WebGPU the engine stays paused after a loss and the
 * page reloads straight back into the same character (net/resume.ts, screens/charselect.ts: takeGpuRecovery).
 *
 * The game runs WebGPU only (Overall Pass item 0): there is no WebGL2 to fall back to, so every loss reloads on WebGPU.
 * LOOP_LIMIT losses within LOOP_WINDOW_MS stop the automatic reloads and leave a notice with a Reload button.
 *
 * Black output (gpu-watchdog.ts): a 3D view that renders nothing without any loss event shows the "3D view is black"
 * help (gpu-help.ts: another browser, or ending Chrome's GPU process). The same help is in the Esc menu and on the login
 * screen for the case no page can detect (Chrome's compositor dropping a correctly drawn canvas).
 */
import type { AbstractEngine } from '@babylonjs/core'
import type { App, ScreenParams } from './app.ts'
import type { EngineKind } from './engine.ts'
import { showGpuHelp } from './gpu-help.ts'
import { registerMenuItem } from './hud/menu-items.ts'
import { t, type StringKey } from './i18n/index.ts'
import { el } from './ui/dom.ts'
import { button } from './ui/kit/button.ts'

/** The part of Storage used here (tests pass a map, or one that throws). */
export interface LossStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Times (ms since epoch) of this tab's recent losses. */
export const LOSSES_KEY = 'sro.gpu.losses'
/** The character to re-enter after the reload ({ characterId, at, reason }). */
export const RECOVER_KEY = 'sro.gpu.recover'

/** Losses older than this are forgotten. */
export const REPEAT_WINDOW_MS = 30 * 60_000
/** This many losses within LOOP_WINDOW_MS stop the automatic reloads. */
export const LOOP_LIMIT = 4
export const LOOP_WINDOW_MS = 10 * 60_000
/** The notice shows this long before the reload. */
export const RELOAD_DELAY_MS = 1500
/** A recovery record older than this is ignored (a later manual reload, a restored tab). */
export const RECOVER_TTL_MS = 120_000

/** Recovery reasons that are not a device loss (the toast after the reload says what happened: `recoveryToast`). */
export const REASON_BLACK = 'black output'
export const REASON_RELOAD = 'reload'

export type RecoveryPlan = 'reload' | 'stop'

export interface GpuLoss {
  kind: EngineKind
  /** GPUDeviceLostInfo.reason ('unknown' for a crash or reset, 'destroyed'). */
  reason: string
  /** GPUDeviceLostInfo.message (Chrome's explanation), '' when none. */
  message: string
}

export interface GpuRecovery {
  characterId: number
  at: number
  reason: string
}

/** What to do about a loss, given this tab's earlier losses (`losses` includes the new one): reload, or stop a loop. */
export function planRecovery(losses: readonly number[], now: number): RecoveryPlan {
  return losses.filter(t => now - t <= LOOP_WINDOW_MS).length >= LOOP_LIMIT ? 'stop' : 'reload'
}

function read<T>(storage: LossStorage | null, key: string): T | null {
  try {
    const text = storage?.getItem(key)
    return text ? (JSON.parse(text) as T) : null
  } catch {
    return null
  }
}

function write(storage: LossStorage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    // storage blocked or full: the reload still happens, it just cannot remember
  }
}

/** sessionStorage, or null when it is blocked. */
export function tabStorage(): LossStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** The character to re-enter after a loss reload, once (the record is removed); null when none or too old. */
export function takeGpuRecovery(now = Date.now(), storage: LossStorage | null = tabStorage()): GpuRecovery | null {
  const r = read<Partial<GpuRecovery>>(storage, RECOVER_KEY)
  try {
    storage?.removeItem(RECOVER_KEY)
  } catch {
    // nothing to remove
  }
  if (!r || typeof r.characterId !== 'number' || typeof r.at !== 'number' || now - r.at > RECOVER_TTL_MS || r.at > now + 5000) return null
  return { characterId: r.characterId, at: r.at, reason: typeof r.reason === 'string' ? r.reason : '' }
}

/** The toast after a recovery reload: the help's Reload, or a lost device. */
export function recoveryToast(r: Pick<GpuRecovery, 'reason'>): StringKey {
  if (r.reason === REASON_RELOAD) return 'gpu.reloaded'
  return 'gpu.restored'
}

export interface GpuLossDeps {
  engine: AbstractEngine
  kind: EngineKind
  storage: LossStorage | null
  /** The character in the world now (the reload goes straight back to it); null on the other screens. */
  character(): number | null
  /** Shows (or replaces) the on-screen notice; `reload` adds a button that reloads now. */
  notice(text: string, reload?: () => void): void
  hideNotice(): void
  /** Shows the "3D view is black" help (gpu-help.ts): black output that switching cannot fix. */
  help(): void
  /** Reloads the page. */
  reload(): void
  /** The notice texts (i18n in the game; tests pass their own). */
  text: { reloading: string; stopped: string }
  now?: () => number
}

type Phase = 'ok' | 'reloading' | 'stopped'

/**
 * Watches the engine for a lost device and recovers (see the header). One loss leads to one recovery: repeated lost
 * events are ignored meanwhile.
 */
export class GpuLossGuard {
  private phase: Phase = 'ok'
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number
  /** Every loss handled, newest last (debugging: `window.__sroGpuLoss`). */
  readonly history: (GpuLoss & { at: number; plan: RecoveryPlan | 'help' })[] = []

  constructor(private readonly deps: GpuLossDeps) {
    this.now = deps.now ?? Date.now
    const e = deps.engine
    holdAfterDeviceLoss(e)
    deviceOf(e)?.lost?.then(
      info => this.lost({ kind: 'WebGPU', reason: info?.reason ?? 'unknown', message: info?.message ?? '' }),
      () => {},
    )
  }

  get state(): Phase {
    return this.phase
  }

  /** A loss (exposed for the guard's tests and the console: `__sroGpuLoss.lost(...)`). */
  lost(loss: GpuLoss): void {
    if (this.deps.engine.isDisposed || this.phase !== 'ok') return
    this.recover(loss, this.now())
  }

  /** The 3D view renders nothing (gpu-watchdog.ts decided so): the help (no other renderer to switch to). */
  blackOutput(detail: string): 'help' | 'ignored' {
    if (this.deps.engine.isDisposed || this.phase !== 'ok') return 'ignored'
    this.history.push({ kind: this.deps.kind, reason: REASON_BLACK, message: detail, at: this.now(), plan: 'help' })
    console.error(`[gpu] ${this.deps.kind}: the 3D view stays black (${detail}); showing the help`)
    this.deps.help()
    return 'help'
  }

  /** Reloads now, back into the world when there (the help's Reload). */
  reloadIntoWorld(reason = REASON_RELOAD): void {
    if (this.phase === 'reloading') return
    this.phase = 'reloading'
    this.keepCharacter(reason, this.now())
    this.deps.reload()
  }

  private keepCharacter(reason: string, at: number): void {
    const characterId = this.deps.character()
    if (characterId !== null) write(this.deps.storage, RECOVER_KEY, { characterId, at, reason } satisfies GpuRecovery)
  }

  private recover(loss: GpuLoss, at: number): void {
    const losses = [...(read<number[]>(this.deps.storage, LOSSES_KEY) ?? []).filter(t => typeof t === 'number' && at - t <= REPEAT_WINDOW_MS), at]
    write(this.deps.storage, LOSSES_KEY, losses)
    const plan = planRecovery(losses, at)
    this.history.push({ ...loss, at, plan })
    const detail = loss.message ? `${loss.reason}: ${loss.message}` : loss.reason
    console.error(`[gpu] ${loss.kind} device lost (${detail}); loss ${losses.length} in this tab's last ${REPEAT_WINDOW_MS / 60_000} min; ${plan}`)
    const reloadNow = () => this.deps.reload()
    if (plan === 'stop') {
      this.phase = 'stopped'
      this.deps.notice(this.deps.text.stopped, reloadNow)
      return
    }
    this.phase = 'reloading'
    this.keepCharacter(detail, at)
    this.deps.notice(this.deps.text.reloading)
    this.timer = setTimeout(() => {
      this.timer = null
      this.deps.reload()
    }, RELOAD_DELAY_MS)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** The part of a GPUDevice the guard reads. */
interface DeviceLike {
  lost?: Promise<{ reason?: string; message?: string } | undefined>
}

/** Babylon's GPUDevice (internal field). */
function deviceOf(engine: AbstractEngine): DeviceLike | null {
  return (engine as unknown as { _device?: DeviceLike })._device ?? null
}

/**
 * Turns off Babylon's in-place WebGPU restore (see the header): the engine keeps `_contextWasLost`, so its render loop
 * stays paused (no frames against the dead device, no validation-error flood) until the page reloads.
 */
export function holdAfterDeviceLoss(engine: AbstractEngine): void {
  ;(engine as unknown as { _restoreEngineAfterContextLost(init: () => unknown): void })._restoreEngineAfterContextLost = () => {}
}

let installed: { app: App; guard: GpuLossGuard } | null = null

/** The installed guard (null before main.ts installs it, and in tests). */
export function gpuLossGuard(): GpuLossGuard | null {
  return installed?.guard ?? null
}

/**
 * Opens the "3D view is black" help (gpu-help.ts): `detected` when the watchdog saw it, else the player asked (Esc
 * menu, login screen).
 */
export function openGpuHelp(detected = false): void {
  if (!installed) return
  const { app, guard } = installed
  showGpuHelp(app.art, {
    detected,
    reload: () => guard.reloadIntoWorld(REASON_RELOAD),
  })
}

/** The game's guard (main.ts): the notice over the canvas, a page reload, the world screen's character. */
export function installGpuLossGuard(app: App, kind: EngineKind): GpuLossGuard {
  let box: HTMLElement | null = null
  const guard = new GpuLossGuard({
    engine: app.engine,
    kind,
    storage: tabStorage(),
    character: () => (app.current === 'world' ? ((app.currentParams as ScreenParams['world'] | undefined)?.character.id ?? null) : null),
    notice: (text, reload) => {
      box ??= document.body.appendChild(el('div', 'gpu-notice'))
      box.replaceChildren(el('div', '', text))
      if (reload) {
        box.append(button(app.art, { label: t('gpu.reload'), primary: true }, () => reload()))
      }
    },
    hideNotice: () => {
      box?.remove()
      box = null
    },
    help: () => openGpuHelp(true),
    reload: () => location.reload(),
    text: { reloading: t('gpu.reloading'), stopped: t('gpu.stopped') },
  })
  installed = { app, guard }
  // Esc → "Screen black?": the help for what no page can detect (Chrome's compositor dropping the 3D canvas).
  registerMenuItem({
    id: 'blackScreen',
    label: 'menu.blackScreen',
    order: 70,
    run: ctx => {
      ctx.close()
      openGpuHelp()
    },
  })
  ;(window as unknown as { __sroGpuLoss?: GpuLossGuard }).__sroGpuLoss = guard
  return guard
}
