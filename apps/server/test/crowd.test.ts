// docs/NETWORK_AUDIT.md R1 (crowd cap) and R5 (local chat in view range).
import type { ServerMessage } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { CROWD_SWAP_M, CROWD_SWAPS_PER_PASS, FOE_MEMORY_MS, World, type Player } from '../src/world.ts'

function setup(n: number, max = 10, spacing = 1) {
  const w = new World('jangan', 5, 20, null)
  w.maxVisiblePlayers = max
  const inbox = new Map<number, ServerMessage[]>()
  const add = (k: number, x: number, z: number): Player => {
    const msgs: ServerMessage[] = []
    const p = w.add({ characterId: 1000 + k, name: `P${k}`, model: 'CHAR_CH_MAN_ADVENTURER', level: 1, weapon: 'blade', pos: [x, 0, z], yaw: 0, send: (m) => msgs.push(m) } as never)
    inbox.set(p.id, msgs)
    return p
  }
  const viewer = add(0, 0, 0)
  // others on a line: player k at k metres
  const others = Array.from({ length: n }, (_, i) => add(i + 1, (i + 1) * spacing, 0))
  const seen = (v: Player) => [...v.known].filter((id) => w.players.has(id))
  return { w, viewer, others, add, inbox, seen }
}

describe('crowd cap', () => {
  it('under the cap everyone in range is shown and no crowd is in force', () => {
    const { w, viewer, seen } = setup(8)
    w.updateInterest(Date.now())
    expect(viewer.crowd).toBeNull()
    expect(seen(viewer)).toHaveLength(8)
  })

  it('over the cap the nearest maxVisiblePlayers are shown; monsters are not affected', () => {
    const { w, viewer, others, seen } = setup(30)
    w.updateInterest(Date.now())
    expect(seen(viewer).sort((a, b) => a - b)).toEqual(others.slice(0, 10).map((p) => p.id).sort((a, b) => a - b))
    expect(viewer.crowd!.size).toBe(10)
  })

  it('hysteresis: a newcomer must be clearly nearer than a shown player to take its place', () => {
    // players every 5 m: the 10 shown at 5..50 m
    const { w, viewer, others, seen } = setup(20, 10, 5)
    const now = Date.now()
    w.updateInterest(now)
    const eleventh = others[10]!
    // nearer than the farthest shown (50 m) but not by CROWD_SWAP_M: no swap
    eleventh.pos = [50 - CROWD_SWAP_M / 2, 0, 0.1]
    w.updateInterest(now + 300)
    expect(seen(viewer)).not.toContain(eleventh.id)
    // clearly nearer: swaps in, the farthest shown one leaves
    eleventh.pos = [0.5, 0, 0.1]
    w.updateInterest(now + 600)
    expect(seen(viewer)).toContain(eleventh.id)
    expect(seen(viewer)).not.toContain(others[9]!.id)
    expect(seen(viewer)).toHaveLength(10)
  })

  it('swaps are rationed: at most CROWD_SWAPS_PER_PASS per pass, so a crowd reshuffle trickles in', () => {
    const { w, viewer, others, seen } = setup(15, 10)
    // 10 shown at 60..105 m, 5 more at 125 m (not shown: the 10 are nearer)
    others.forEach((p, i) => (p.pos = i < 10 ? [60 + 5 * i, 0, 0] : [125, 0, 0]))
    const now = Date.now()
    w.updateInterest(now)
    const newcomers = others.slice(10)
    const fresh = () => newcomers.filter((p) => seen(viewer).includes(p.id)).length
    expect(fresh()).toBe(0)
    // all five walk right up to the viewer at once
    for (const p of newcomers) p.pos = [1, 0, 0]
    w.updateInterest(now + 300)
    expect(fresh()).toBe(CROWD_SWAPS_PER_PASS)
    for (let k = 2; k <= 6; k++) w.updateInterest(now + 300 * k)
    expect(fresh()).toBe(5)
    expect(seen(viewer)).toHaveLength(10)
  })

  it('always shown: the target, whoever targets you, recent foes, and gameplay\'s rule (party/guild)', () => {
    const { w, viewer, others, seen } = setup(30)
    const now = Date.now()
    const [far1, far2, far3, far4] = [others[25]!, others[26]!, others[27]!, others[28]!]
    viewer.action = { kind: 'attack', target: far1.id, chaseAt: 0, chaseTo: null }
    far2.action = { kind: 'skill', skill: 'X', target: viewer.id, chaseAt: 0, chaseTo: null }
    w.noteFoes(viewer, far3, now)
    w.alsoMustSee = (_v, o) => o.id === far4.id
    w.updateInterest(now)
    for (const p of [far1, far2, far3, far4]) expect(seen(viewer)).toContain(p.id)
    // they count toward the cap: the 4 must-see + the 6 nearest
    expect(seen(viewer)).toHaveLength(10)
    for (const p of others.slice(0, 6)) expect(seen(viewer)).toContain(p.id)
    // the foe memory runs out
    w.alsoMustSee = null
    viewer.action = null
    far2.action = null
    w.updateInterest(now + FOE_MEMORY_MS + 1)
    expect(seen(viewer)).toHaveLength(10)
  })

  it('a player entering the world in a crowd gets the capped snapshot', () => {
    const { w, add } = setup(30)
    const late = add(99, 0.2, 0)
    const snap = w.snapshotFor(late)
    expect(snap.filter((e) => e.kind === 'player')).toHaveLength(10)
  })

  it('cap 0 turns it off', () => {
    const { w, viewer, seen } = setup(30, 0)
    w.updateInterest(Date.now())
    expect(seen(viewer)).toHaveLength(30)
  })
})

describe('local chat range', () => {
  it('reaches players within view range only (crowd cap or not), and the speaker', () => {
    const { w, viewer, add, inbox } = setup(30)
    const far = add(200, w.viewRange + 5, 0)
    const msg = { t: 'chat', channel: 'local', fromId: viewer.id, from: 'P0', text: 'hi' } as ServerMessage
    w.sayLocal(viewer, msg)
    const got = (p: Player) => inbox.get(p.id)!.includes(msg)
    expect(got(viewer)).toBe(true)
    expect(got(w.players.get(viewer.id + 30)!)).toBe(true) // the 30th player: hidden by the cap, still hears
    expect(got(far)).toBe(false)
  })
})
