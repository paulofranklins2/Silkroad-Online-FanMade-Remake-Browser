/**
 * The admin panel's live operations (docs/ADMIN.md §3.2, `admin/ops.ts`): the `ops` route group runs the GM commands
 * that need no character from typed, bounded parameters only; admin role only; a gm_audit row per action.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { GameContext } from '../src/game.ts'
import { OPS_FEATURES, opsArgs, routeAdminOps } from '../src/admin/ops.ts'
import { COMMANDS } from '../src/gm.ts'
import { skillHarness } from './skills-fixtures.ts'

let cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function harness() {
  const h = skillHarness({ config: { uniques: false } })
  cleanups.push(h.cleanup)
  const audits: { command: string; args: string[]; ok: boolean }[] = []
  const store = new Proxy(h.store, { get: (t, k) => (k === 'audit' ? (e: { command: string; args: string[]; ok: boolean }) => audits.push(e) : Reflect.get(t, k)) })
  const ctx = { gameplay: h.gameplay, world: h.world, data: h.data, store, config: { ...h.config, log: () => {} }, sockets: new Map() } as unknown as GameContext
  const call = (method: string, sub: string, body?: unknown, role: 'admin' | 'gm' = 'admin') =>
    routeAdminOps(ctx, { method, path: `/api/admin/ops${sub}`, query: new URLSearchParams(''), body, actor: { accountId: 1, role, username: 'root' } }) as { status: number; body: any }
  return { h, call, audits }
}

describe('admin ops', () => {
  it('every feature runs a command that needs no character', () => {
    for (const f of OPS_FEATURES) {
      expect(COMMANDS[f.command], f.command).toBeDefined()
      expect(COMMANDS[f.command]!.world, f.command).toBe(f.selfless ? true : undefined)
      for (const a of f.actions) for (const w of a.args) if (w.startsWith('$')) expect(a.params?.some((x) => `$${x.name}` === w), `${f.id}.${a.id} ${w}`).toBe(true)
    }
  })

  it('admins only', () => {
    const { call } = harness()
    expect(call('GET', '', undefined, 'gm').status).toBe(403)
    expect(call('POST', '/time', { action: 'freeze' }, 'gm').status).toBe(403)
  })

  it('lists every feature with its status', () => {
    const { call } = harness()
    const r = call('GET', '')
    expect(r.status).toBe(200)
    expect(r.body.features.map((f: { id: string }) => f.id)).toEqual(OPS_FEATURES.map((f) => f.id))
    const time = r.body.features.find((f: { id: string }) => f.id === 'time')
    expect(time.state.ok).toBe(true)
    expect(time.status).toBeUndefined()
    expect(call('GET', '/weather').body.state.message).toMatch(/weather|Weather/)
  })

  it('runs an action, audits it, and refuses bad input', () => {
    const { h, call, audits } = harness()
    const r = call('POST', '/time', { action: 'set', params: { time: '06:30' } })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(audits).toEqual([expect.objectContaining({ command: 'time', args: ['06:30'], ok: true })])
    expect(call('POST', '/time', { action: 'freeze' }).status).toBe(200)
    expect(h.gameplay.clock.state.running).toBe(false)
    expect(call('POST', '/time', { action: 'set', params: { time: '6:30 day 5' } }).status).toBe(400)
    expect(call('POST', '/time', { action: 'rm -rf' }).status).toBe(400)
    expect(call('POST', '/time', { action: 'day', params: { day: 1.5 } }).status).toBe(400)
    expect(call('POST', '/time', { action: 'day', params: { day: 3, extra: 1 } }).status).toBe(400)
    expect(call('POST', '/time', { action: 'freeze', cmd: 'x' }).status).toBe(400)
    expect(call('POST', '/nope', { action: 'x' }).status).toBe(404)
    expect(audits).toHaveLength(2)
  })

  it('answers 422 with the command refusal', () => {
    const { call, audits } = harness()
    const r = call('POST', '/guilds', { action: 'info', params: { guild: 'Nobody' } })
    expect(r.status).toBe(422)
    expect(r.body.message).toBeTruthy()
    expect(audits[0]).toMatchObject({ command: 'guilds', ok: false })
    expect(call('POST', '/penalty', { action: 'show', params: { player: 'Nobody' } }).body.message).not.toBe('internal error')
    expect(call('GET', '/rarity').body.state.ok).toBe(true)
  })

  it('builds one argument per parameter; optional ones drop the tail', () => {
    const storm = OPS_FEATURES.find((f) => f.id === 'storm')!.actions.find((a) => a.id === 'start')!
    expect(opsArgs(storm, {})).toEqual(['start'])
    expect(opsArgs(storm, { minutes: 5 })).toEqual(['start', '5'])
    expect(opsArgs(storm, { minutes: 5, forecast: '2' })).toEqual(['start', '5', '2'])
    expect(opsArgs(storm, { minutes: 5000 })).toEqual({ error: expect.stringMatching(/Minutes/) })
    const kick = OPS_FEATURES.find((f) => f.id === 'guilds')!.actions.find((a) => a.id === 'kick')!
    expect(opsArgs(kick, { guild: 'A B', player: 'x' })).toHaveProperty('error')
    expect(opsArgs(kick, { guild: 'Lions', player: 'Mei' })).toEqual(['kick', 'Lions', 'Mei'])
  })
})
