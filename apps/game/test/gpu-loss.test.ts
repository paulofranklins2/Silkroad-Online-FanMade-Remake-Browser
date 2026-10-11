/**
 * The 2026-10-05 black screen: a lost graphics device (WebGPU device.lost) must never leave the game silently black.
 * gpu-loss.ts keeps Babylon's broken in-place WebGPU restore off and shows a notice whose Reload goes straight back into the
 * world (net/resume.ts); it never reloads by itself (2026-10-11 report). WebGPU only (Overall Pass item 0): no WebGL2 fallback.
 */
import { Observable, type AbstractEngine } from '@babylonjs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '../src/app.ts'
import {
  GpuLossGuard,
  REASON_RELOAD,
  recoveryToast,
  LOOP_LIMIT,
  LOSSES_KEY,
  RECOVER_KEY,
  RECOVER_TTL_MS,
  REPEAT_WINDOW_MS,
  planRecovery,
  takeGpuRecovery,
  type GpuLossDeps,
  type LossStorage,
} from '../src/gpu-loss.ts'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { resumeSession, saveSession } from '../src/net/resume.ts'
import { Session } from '../src/net/session.ts'

function storage(): LossStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: k => void map.delete(k) }
}

/** A WebGPU engine as the guard sees it: Babylon's device (its `lost` promise) and the restore it turns off. */
function fakeWebGPU() {
  let lose!: (info: { reason: string; message: string }) => void
  const lost = new Promise<{ reason: string; message: string }>(r => (lose = r))
  const restore = vi.fn()
  const engine = {
    isDisposed: false,
    _device: { lost },
    _restoreEngineAfterContextLost: restore,
    onContextLostObservable: new Observable<AbstractEngine>(),
    onContextRestoredObservable: new Observable<AbstractEngine>(),
  }
  return { engine, lose, restore }
}

const TEXT = { reloading: 'reloading', stopped: 'stopped' }

function deps(engine: unknown, kind: GpuLossDeps['kind'], store: LossStorage, character: number | null = 7) {
  const d = {
    engine: engine as AbstractEngine,
    kind,
    storage: store,
    character: vi.fn(() => character),
    notice: vi.fn<(text: string, reload?: () => void) => void>(),
    hideNotice: vi.fn(),
    help: vi.fn(),
    reload: vi.fn(),
    text: TEXT,
  }
  return d
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('planRecovery', () => {
  const now = 10_000_000
  it('reloads on WebGPU, stops after a loop', () => {
    expect(planRecovery([now], now)).toBe('reload')
    expect(planRecovery([now - REPEAT_WINDOW_MS + 1000, now], now)).toBe('reload')
    const loop = Array.from({ length: LOOP_LIMIT }, (_, i) => now - i * 60_000)
    expect(planRecovery(loop, now)).toBe('stop')
  })
})

describe('GpuLossGuard on WebGPU', () => {
  it('a lost device: Babylon\x27s restore stays off, a notice with a Reload button shows, and the page NEVER reloads by itself', async () => {
    const store = storage()
    const { engine, lose, restore } = fakeWebGPU()
    const d = deps(engine, 'WebGPU', store)
    const guard = new GpuLossGuard(d)
    // Babylon's own restore (which rebuilds on the dead device) is replaced by a no-op: the render loop stays paused.
    expect(engine._restoreEngineAfterContextLost).not.toBe(restore)
    const init = vi.fn()
    engine._restoreEngineAfterContextLost(init)
    expect(init).not.toHaveBeenCalled()

    lose({ reason: 'unknown', message: 'GPU process crashed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(guard.state).toBe('lost')
    expect(guard.history[0]).toMatchObject({ kind: 'WebGPU', reason: 'unknown', message: 'GPU process crashed', plan: 'reload' })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unknown: GPU process crashed'))
    expect(JSON.parse(store.map.get(LOSSES_KEY)!)).toHaveLength(1)
    const [text, reload] = d.notice.mock.calls[0]!
    expect(text).toBe('reloading')
    expect(reload).toBeTypeOf('function')

    // A second event for the same loss does not start another recovery; minutes pass: still no reload.
    guard.lost({ kind: 'WebGPU', reason: 'unknown', message: 'again' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(d.reload).not.toHaveBeenCalled()
    expect(d.notice).toHaveBeenCalledTimes(1)
    expect(store.map.has(RECOVER_KEY)).toBe(false)

    // The player clicks Reload (late): the character is kept from that moment (fresh for takeGpuRecovery), then reload.
    reload!()
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(guard.state).toBe('reloading')
    const rec = JSON.parse(store.map.get(RECOVER_KEY)!)
    expect(rec).toMatchObject({ characterId: 7, reason: 'unknown: GPU process crashed' })
    expect(takeGpuRecovery(Date.now(), store)).not.toBeNull()
    reload!()
    expect(d.reload).toHaveBeenCalledTimes(1)
    guard.dispose()
  })

  it('a loop of losses shows the "keeps failing" advice, still only reloading on a click', async () => {
    const store = storage()
    const run = async () => {
      const { engine, lose } = fakeWebGPU()
      const d = deps(engine, 'WebGPU', store)
      const guard = new GpuLossGuard(d)
      lose({ reason: 'unknown', message: '' })
      await vi.advanceTimersByTimeAsync(60_000)
      guard.dispose()
      return { d, guard }
    }
    const first = await run()
    expect(first.guard.history[0]!.plan).toBe('reload')
    expect(first.d.notice.mock.calls[0]![0]).toBe('reloading')
    expect(first.d.reload).not.toHaveBeenCalled()
    for (let i = 1; i < LOOP_LIMIT - 1; i++) await run()
    const last = await run()
    expect(last.guard.state).toBe('stopped')
    expect(last.d.reload).not.toHaveBeenCalled()
    const [text, reload] = last.d.notice.mock.calls[0]!
    expect(text).toBe('stopped')
    reload!()
    expect(last.d.reload).toHaveBeenCalledTimes(1)
  })

  it('off the world screen nothing is kept to re-enter; a disposed engine is ignored', async () => {
    const store = storage()
    const { engine, lose } = fakeWebGPU()
    const d = deps(engine, 'WebGPU', store, null)
    new GpuLossGuard(d)
    lose({ reason: 'unknown', message: '' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(d.reload).not.toHaveBeenCalled()
    d.notice.mock.calls[0]![1]!()
    expect(store.map.has(RECOVER_KEY)).toBe(false)
    expect(d.reload).toHaveBeenCalledTimes(1)

    const other = fakeWebGPU()
    const d2 = deps(other.engine, 'WebGPU', storage())
    new GpuLossGuard(d2)
    other.engine.isDisposed = true
    other.lose({ reason: 'destroyed', message: '' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(d2.notice).not.toHaveBeenCalled()
    expect(d2.reload).not.toHaveBeenCalled()
  })
})

describe('takeGpuRecovery', () => {
  it('hands the record out once, and only while it is fresh and well-formed', () => {
    const store = storage()
    const now = 50_000_000
    store.setItem(RECOVER_KEY, JSON.stringify({ characterId: 3, at: now - 1000, reason: 'unknown' }))
    expect(takeGpuRecovery(now, store)).toEqual({ characterId: 3, at: now - 1000, reason: 'unknown' })
    expect(takeGpuRecovery(now, store)).toBeNull()
    store.setItem(RECOVER_KEY, JSON.stringify({ characterId: 3, at: now - RECOVER_TTL_MS - 1 }))
    expect(takeGpuRecovery(now, store)).toBeNull()
    store.setItem(RECOVER_KEY, '{nope')
    expect(takeGpuRecovery(now, store)).toBeNull()
    const blocked: LossStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(takeGpuRecovery(now, blocked)).toBeNull()
  })
})

describe('the reload after a loss', () => {
  it('resumes the saved session straight into the world with the same character', async () => {
    vi.useRealTimers()
    const store = storage()
    vi.stubGlobal('sessionStorage', store)
    const memory: KeyValueStore = { getItem: k => store.map.get(`db:${k}`) ?? null, setItem: (k, v) => void store.map.set(`db:${k}`, v) }
    const server = new MockServer(memory, 0)
    await server.register({ username: 'carol', password: 'secret' })
    const { token, expiresAt } = await server.login({ username: 'carol', password: 'secret' })
    const setup = new Session(() => server.wire(), token)
    await setup.connect()
    const { character } = await setup.request({ t: 'charCreate', name: 'Grinder', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' }, ['charCreated'])
    setup.close('logout')

    const go = vi.fn(async () => {})
    const toast = vi.fn()
    const app = { transport: { mock: true, api: server, wire: () => server.wire() }, go, toast, setSession: vi.fn(), token: '', username: '', tokenExpiresAt: 0 }
    saveSession({ token, username: 'carol', expiresAt }, true, store)
    store.setItem(RECOVER_KEY, JSON.stringify({ characterId: character.id, at: Date.now(), reason: 'unknown' }))
    expect(await resumeSession(app as unknown as App)).toBe(true)
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith('world', { character: expect.objectContaining({ id: character.id, name: 'Grinder' }) })
    expect(toast).toHaveBeenCalledTimes(1)
    expect(store.map.has(RECOVER_KEY)).toBe(false)

    // Without a record (a plain refresh) the resume lands on character select as before.
    go.mockClear()
    expect(await resumeSession(app as unknown as App)).toBe(true)
    expect(go).toHaveBeenCalledWith('charselect')
  })
})

describe('black output (gpu-watchdog.ts → GpuLossGuard.blackOutput)', () => {
  it('shows the help (nothing to switch to), never a reload', async () => {
    const store = storage()
    const { engine } = fakeWebGPU()
    const d = deps(engine, 'WebGPU', store)
    const guard = new GpuLossGuard(d)
    expect(guard.blackOutput('3 empty samples')).toBe('help')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(d.help).toHaveBeenCalledTimes(1)
    expect(d.reload).not.toHaveBeenCalled()
    expect(store.map.has(RECOVER_KEY)).toBe(false)
    expect(guard.state).toBe('ok')
    guard.dispose()
  })

  it('the help\'s Reload goes back into the world once', () => {
    const store = storage()
    const g = new GpuLossGuard(deps(fakeWebGPU().engine, 'WebGPU', store))
    const d = (g as unknown as { deps: ReturnType<typeof deps> }).deps
    g.reloadIntoWorld(REASON_RELOAD)
    g.reloadIntoWorld(REASON_RELOAD)
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(recoveryToast(JSON.parse(store.map.get(RECOVER_KEY)!))).toBe('gpu.reloaded')
    expect(recoveryToast({ reason: 'unknown: GPU process crashed' })).toBe('gpu.restored')
  })
})
