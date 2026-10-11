/**
 * docs/NETWORK_AUDIT.md §6: inbound frame fuzzing. Random frames for every client message type (keys from a pool of
 * the protocol's field names, values from a pool of edge cases) must never throw in the parser, never reach a handler
 * that throws ("error handling" in the log), and may only ever close the socket for abuse.
 */
import { CLIENT_RATE_LIMITS, CLOSE_CODE, parseClientMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MESSAGE_RATE_LIMITS } from '../src/connection.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'

const TYPES = [...new Set([...Object.keys(CLIENT_RATE_LIMITS), ...Object.keys(MESSAGE_RATE_LIMITS), 'chat', 'gm', 'hello', 'charLook'])]
const KEYS = ['id', 'target', 'bag', 'slot', 'count', 'npc', 'x', 'z', 'item', 'name', 'amount', 'from', 'to', 'text', 'channel', 'accept', 'skill', 'code', 'index', 'dir', 'kind', 'quest', 'choice', 'look', 'args', 'cmd', 'n', 'clientTime', 'model', 'weapon', 'equip', 'price', 'owner', 'items', 'art', 'emote', 'level']
const VALUES: unknown[] = [0, -1, 1, 7, 2 ** 31, -(2 ** 53), 1e308, 0.5, '', 'a', 'x'.repeat(300), '__proto__', 'constructor', '‮', [], [1, 2], {}, { equip: 'weapon' }, null, true, false, 'CHAR_CH_MAN_ADVENTURER', 'ITEM_ETC_HP_POTION_01', 'local', 'party']

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function frames(n: number, seed: number): string[] {
  const r = seeded(seed)
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const o: Record<string, unknown> = { t: pick(TYPES) }
    const k = Math.floor(r() * 4)
    for (let j = 0; j < k; j++) o[pick(KEYS)] = pick(VALUES)
    out.push(r() < 0.03 ? JSON.stringify(o).slice(0, Math.floor(r() * 20)) : JSON.stringify(o))
  }
  return out
}

describe('inbound frame fuzz', () => {
  it('the parser never throws and only ever accepts the type it was given', () => {
    for (const f of frames(20_000, 1)) {
      const r = parseClientMessage(f)
      if (r.ok) expect(r.msg.t).toBe((JSON.parse(f) as { t: string }).t)
    }
  })

  describe('over a real socket', () => {
    let s: TestServer
    const logs: string[] = []
    beforeAll(async () => {
      s = await startTestServer({ logs })
    })
    afterAll(async () => {
      await s.stopAndClean()
    })

    it('no handler throws; a closed socket is only ever an abuse close', async () => {
      const acc = await newAccount(s.url, 'fuzz')
      const c = await Client.login(s.url, acc.token)
      c.send({ t: 'charCreate', name: 'Fuzzer', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
      const ch = (await c.next('charCreated')).character
      c.send({ t: 'enterWorld', id: ch.id })
      await c.next('worldEnter')
      // parser-valid frames only (an invalid one is a strike, and the strikes would close the socket within a second),
      // without hello and gm (both strikes for a player); 30 every 500 ms, under the flood ceiling
      const all = frames(200_000, 2).filter((f) => { const r = parseClientMessage(f); return r.ok && r.msg.t !== 'hello' && r.msg.t !== 'gm' }).slice(0, 600)
      expect(all.length).toBeGreaterThan(100)
      for (let i = 0; i < all.length && !c.isClosed; i += 30) {
        for (const f of all.slice(i, i + 30)) c.ws.send(f)
        await sleep(500)
      }
      if (c.isClosed) expect((await c.closed).code).toBe(CLOSE_CODE.abuse)
      else c.close()
      console.log(`fuzz: ${all.length} parser-valid frames, ${new Set(all.map((f) => JSON.parse(f).t)).size} types, closed: ${c.isClosed}`)
      expect(logs.filter((l) => l.startsWith('error handling'))).toEqual([])
    }, 60_000)
  })
})
